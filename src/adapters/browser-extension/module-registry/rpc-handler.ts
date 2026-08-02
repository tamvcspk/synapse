import type { ManifestReport, RpcRequest, RpcResponse } from '../../../kernel/rpc';
import { SCOPE_CATALOG, grantsAllow, isMatchExemptMethod, resourceUrlForCall, scopeForApiMethod } from '../../../kernel/scopes';
import type { SynapseApi, SynapseScopeGrant } from '../../../kernel/synapse-api';
import { hashScriptSource } from '../../../shared/source-hash';
import { getActivationMap, getGrantedScopes, getUploadedSources, setManifestReport } from './storage';
import { createSynapseApi } from './synapse-api-host';

/**
 * Background-side authority for the `synapseApi` RPC bridge (docs/ROADMAP.md §11.3). The shim
 * (user-script-shim.ts) runs in a world the user's own code controls and is never trusted to
 * self-limit — every call is re-checked here against persisted activation + the scope grant the
 * user actually approved, for the source they approved it for.
 *
 * Two things this refuses to do, both deliberate:
 *
 * - **No raw service routing.** Requests name a namespace of `SynapseApi` and are resolved against
 *   `scopeForApiMethod`; anything not in the catalog is rejected. The old handler forwarded
 *   `req.args` straight into a Kernel Service, which is how an unnamespaced `cache` turned into
 *   "write your own grants" (see script-storage.ts).
 * - **No auto-grant for an id it doesn't recognize as bundled.** An id absent from the uploaded map
 *   gets `trustedScopes`, which the composition root builds from build-time declarations only.
 */

/** Scopes granted to build-time Modules, derived from their own `Module.scopes` and passed in by
 * the composition root (background/index.ts). Never read from storage: first-party permissions
 * must not live in a store that scripts might one day reach. */
export type TrustedScopeMap = Record<string, SynapseScopeGrant[]>;

export function registerRpcHandler(trustedScopes: TrustedScopeMap = {}): void {
  const listener = (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => {
    if (isManifestReport(msg)) {
      void handleManifestReport(msg);
      return;
    }
    if (!isRpcRequest(msg)) return;
    handleRpc(msg, trustedScopes, sender).then(sendResponse);
    return true;
  };

  /**
   * **Both events, and they are not interchangeable.** Chrome routes messages from a USER_SCRIPT
   * world to `onUserScriptMessage`, never to `onMessage` — deliberately, so that an extension
   * cannot accidentally hand user-supplied code the same handlers it wrote for its own content
   * scripts. Registering only `onMessage` (the obvious thing, and what this file did at first) made
   * every uploaded script's call fail with Chrome's generic *"Could not establish connection.
   * Receiving end does not exist."* — which reads like a dead service worker, not like a message
   * arriving on an event nobody subscribed to. The same miss also swallowed every
   * `synapse:manifest-report`, so uploaded scripts never reported their `scopes` and the popup had
   * no Grant button to show: one root cause, two symptoms that look unrelated.
   *
   * `onMessage` is still required — it carries the bundled-dom-Module transport
   * (`content-scripts/rpc-client.ts`), which is an ordinary content script.
   */
  // Guarded the same way `background/index.ts` guards `chrome.userScripts` itself: with "Allow User
  // Scripts" disabled this event may not exist, and an uncaught throw during the service worker's
  // top-level evaluation discards EVERY listener in the extension, not just this one
  // (docs/LESSONS.md). A property access is not too small to wrap here.
  try {
    chrome.runtime.onUserScriptMessage.addListener(listener);
  } catch (err) {
    console.warn('Synapse: chrome.runtime.onUserScriptMessage is unavailable — uploaded user scripts cannot reach the extension until "Allow User Scripts" is enabled in chrome://extensions.', err);
  }

  chrome.runtime.onMessage.addListener(listener);
}

/** Walks a possibly-dotted method name ('request' or 'mock.add') down from a namespace object —
 * `scopes.ts`'s catalog has always allowed dotted method names (`lib.hls.parse`), but until
 * `net.mock` every dotted entry was `transport: 'in-world'` and never reached this file at all.
 * `net.mock.add/remove/list` is the first RPC-dispatched one, so a single-level property lookup
 * stops being enough — this generalizes it rather than special-casing `net.mock`. */
function resolveMethodHandler(namespaceObj: Record<string, unknown>, method: string): ((...args: unknown[]) => unknown) | undefined {
  let cur: unknown = namespaceObj;
  for (const part of method.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'function' ? (cur as (...args: unknown[]) => unknown) : undefined;
}

function isRpcRequest(msg: unknown): msg is RpcRequest {
  return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'synapse:rpc';
}

function isManifestReport(msg: unknown): msg is ManifestReport {
  return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'synapse:manifest-report';
}

async function handleManifestReport(report: ManifestReport): Promise<void> {
  const { type: _type, ...stored } = report;
  await setManifestReport(report.moduleId, stored);
}

/** Hashing every uploaded source on every call would be wasteful, and the service worker's memory
 * is the right lifetime for the memo: it dies with the worker, so a source edited while the worker
 * was asleep is re-hashed on the next wake. Keyed by source text, not id — a changed source is a
 * different entry by construction, which is the only way this can go stale safely. */
const sourceHashMemo = new Map<string, string>();

async function memoizedSourceHash(source: string): Promise<string> {
  const cached = sourceHashMemo.get(source);
  if (cached) return cached;
  const hash = await hashScriptSource(source);
  sourceHashMemo.set(source, hash);
  return hash;
}

/** What this module is allowed to do, and whether it exists at all. */
async function resolveGrantedScopes(
  moduleId: string,
  trustedScopes: TrustedScopeMap,
): Promise<SynapseScopeGrant[] | undefined> {
  const uploaded = await getUploadedSources();
  const source = uploaded[moduleId];
  if (source !== undefined) {
    return getGrantedScopes(moduleId, await memoizedSourceHash(source));
  }
  return trustedScopes[moduleId];
}

async function handleRpc(req: RpcRequest, trustedScopes: TrustedScopeMap, sender: chrome.runtime.MessageSender): Promise<RpcResponse> {
  const fail = (error: string): RpcResponse => ({ type: 'synapse:rpc-result', callId: req.callId, error });

  try {
    const requiredScope = scopeForApiMethod(req.namespace, req.method);
    if (!requiredScope) {
      return fail(`Unknown method "${String(req.namespace)}.${req.method}"`);
    }

    const activation = await getActivationMap();
    if (activation[req.moduleId] === false) {
      return fail(`Module "${req.moduleId}" is inactive`);
    }

    const granted = await resolveGrantedScopes(req.moduleId, trustedScopes);
    if (granted === undefined) {
      return fail(`Unknown module "${req.moduleId}"`);
    }
    // matchExempt (kernel/scopes.ts) covers a method that reads/removes something already
    // resource-checked when it was CREATED (e.g. net.mock.remove/list next to mock.add) — for those,
    // grantsAllow's generic "no resourceUrl ⇒ deny" would make the method permanently unusable, so
    // the check drops to "is the scope granted at all", the same bar files.save (no resource
    // dimension) already clears. Ownership (moduleId), not match, is what isolates callers there.
    //
    // `sender.tab` (populated for both onMessage and onUserScriptMessage — a content script or an
    // uploaded script is always attached to a real tab) is `page.eval`'s resourceUrl: it has no
    // per-call url ARGUMENT the way net.request/net.mock do, because the resource it touches is the
    // caller's own tab, not something named in `req.args`. Reading it from `sender` rather than
    // trusting anything in `req.args` is the point — a script cannot widen its own reach by claiming
    // to run on a different origin than it actually does. Built conditionally, not `{ tabUrl:
    // sender.tab?.url }`, because this project's `exactOptionalPropertyTypes` treats an explicit
    // `undefined` differently from an absent key.
    const resourceUrlContext = sender.tab?.url !== undefined ? { tabUrl: sender.tab.url } : {};
    const resourceUrl = resourceUrlForCall(req.namespace, req.method, req.args, resourceUrlContext);
    const scopeOk = isMatchExemptMethod(req.namespace, req.method)
      ? granted.some((g) => g.scope === requiredScope)
      : grantsAllow(granted, requiredScope, resourceUrl);
    if (!scopeOk) {
      // Three distinct denial reasons collapsed into one generic message before this — indistinguishable
      // from the caller's side, and "not granted" was actively misleading for the other two while
      // `page.eval` (the first requiresMatch scope with no url ARGUMENT — its resourceUrl comes from
      // `sender.tab` instead, see the comment above) was being verified on real Chrome: a denial there
      // could equally mean "scope never granted", "sender.tab was missing/empty so no resourceUrl could
      // be determined at all" (this codebase has never confirmed `sender.tab` is populated for
      // `onUserScriptMessage` the same way it is for `onMessage` — see docs/LESSONS.md's own note that
      // user-script messaging has surprised this codebase before), or "granted, but for a different
      // domain than the tab you're actually on". Splitting them turns a silent guessing game into a
      // message that says which one happened.
      const hasScope = granted.some((g) => g.scope === requiredScope);
      if (!hasScope) {
        return fail(`Scope "${requiredScope}" is not granted for module "${req.moduleId}"`);
      }
      if (SCOPE_CATALOG[requiredScope].requiresMatch && !resourceUrl) {
        return fail(
          `Scope "${requiredScope}" is granted, but no resource url could be determined for this call ` +
            `(sender.tab was ${sender.tab ? `present with url ${JSON.stringify(sender.tab.url)}` : 'absent'}) — denying, fail-closed`,
        );
      }
      return fail(
        `Scope "${requiredScope}" is granted for module "${req.moduleId}", but "${resourceUrl}" does not ` +
          'fall under any of its granted match patterns',
      );
    }

    // tabId likewise comes only from `sender`, never from `req.args` — it's what lets
    // synapse-api-host.ts's page.eval implementation know WHICH tab's MAIN world to run in.
    const apiContext = sender.tab?.id !== undefined ? { tabId: sender.tab.id } : {};
    const api = createSynapseApi(req.moduleId, apiContext);
    const namespace = api[req.namespace] as unknown as Record<string, unknown>;
    const handler = resolveMethodHandler(namespace, req.method);
    if (!handler) {
      return fail(`Unknown method "${String(req.namespace)}.${req.method}"`);
    }
    try {
      const result = await handler(...req.args);
      return { type: 'synapse:rpc-result', callId: req.callId, result };
    } catch (err) {
      // Unlike the fail(...) calls above (expected denials — inactive module, ungranted scope,
      // unknown method — deliberately silent, see ROADMAP.md §11.6's write-up on why), a throw from
      // the IMPLEMENTATION itself is never expected. Logged here, with the stack, specifically
      // because it wasn't: `response.error` only ever carries `err.message` back to the caller (it
      // has to survive structured clone), so without this the service worker console shows nothing
      // at all for a real bug — the caller sees just the message, at a call site inside its own
      // wrapped source, with no way to point back at where in the extension it actually happened.
      console.error(`Synapse: ${req.namespace}.${req.method} threw`, err);
      throw err;
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
