import type {
  DryRunLogMessage,
  DryRunResultMessage,
  ManifestReport,
  RpcRequest,
  RpcResponse,
  SubStateQuery,
  SubStateQueryResponse,
} from '../../../kernel/rpc';
import { SCOPE_CATALOG, grantsAllow, isMatchExemptMethod, resourceUrlForCall, scopeForApiMethod } from '../../../kernel/scopes';
import type { SynapseApi, SynapseScopeGrant } from '../../../kernel/synapse-api';
import { chooseMechanismForScriptRule } from '../../../shared/http-mock';
import { hashScriptSource } from '../../../shared/source-hash';
import { getActivationMap, getGrantedScopes, getSubStateMap, getUploadedSources, setManifestReport } from './storage';
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
    if (isDryRunLog(msg) || isDryRunResult(msg)) {
      // Fire-and-forget re-broadcast, NOT persisted anywhere (docs/ROADMAP.md §12.5) — a USER_SCRIPT
      // world's chrome.runtime.sendMessage only reaches onUserScriptMessage, never an extension
      // page's own onMessage, so Studio's console panel can't hear the injected dry-run code
      // directly. Re-sending the exact same message via the background's own chrome.runtime.sendMessage
      // is the same relay shape action-progress.ts documents for a content script broadcasting to
      // every open extension page.
      //
      // `sender.tab` gates the re-send, deliberately: this same `listener` function is ALSO
      // registered on `onMessage` (see below), and whether a context's own `chrome.runtime.sendMessage`
      // loops back into its OWN `onMessage` listeners is not something this codebase has verified
      // either way. The original message is always tab-sourced (injected into a real page via
      // `chrome.userScripts.execute`); a hypothetical self-received echo of THIS relay would come
      // from the background's own context instead, which has no `sender.tab` — so gating on its
      // presence relays exactly once no matter which way that unverified behavior actually goes,
      // the same "don't trust it either way, code the guard" posture background/index.ts's own
      // `DownloadEngineRelayedCommand` double-delivery bugfix comment describes.
      if (sender.tab) chrome.runtime.sendMessage(msg).catch(() => {});
      return;
    }
    if (isSubStateQuery(msg)) {
      handleSubStateQuery(msg).then(sendResponse);
      return true;
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

function isDryRunLog(msg: unknown): msg is DryRunLogMessage {
  return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'synapse:dry-run-log';
}

function isDryRunResult(msg: unknown): msg is DryRunResultMessage {
  return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'synapse:dry-run-result';
}

async function handleManifestReport(report: ManifestReport): Promise<void> {
  const { type: _type, ...stored } = report;
  await setManifestReport(report.moduleId, stored);
}

function isSubStateQuery(msg: unknown): msg is SubStateQuery {
  return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'synapse:sub-state-query';
}

/** Answers an uploaded script's pre-run request for its own per-step bypass map (docs/ROADMAP.md
 * §12.3) — read directly from storage, no scope/activation check: this is the script reading its
 * OWN already-declared steps' toggle state, the same data `createCompositeModule`'s `getSubState`
 * callback reads directly for a bundled Module, not a capability that needs gating. */
async function handleSubStateQuery(msg: SubStateQuery): Promise<SubStateQueryResponse> {
  const map = await getSubStateMap();
  return { subState: map[msg.moduleId] ?? {} };
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

    // net.request's `secrets.use` gate (docs/ROADMAP.md §11.6) can't be expressed through the
    // generic one-method-one-scope dispatch above: it only applies when THIS call's own headers
    // reference a secret by name, an argument-shape condition scopeForApiMethod/grantsAllow have no
    // way to see (they only know a method's OWN fixed scope, resolved before any argument is
    // inspected). Checked here instead, at the same trust boundary as every other scope check in
    // this function — the actual per-secret host-binding check (independent of any grant, since a
    // secret is bound to a host once at creation, not per script) happens one layer down, in
    // net-request-host.ts/ai-ask-host.ts (via secret-resolution.ts), uniformly for every transport
    // (see net-request-host.ts's own doc comment). `ai.ask`'s `options.secretRef` is the same shape
    // of condition, just a plain field instead of a header value — same reasoning, same place.
    if (!granted.some((g) => g.scope === 'secrets.use')) {
      if (req.namespace === 'net' && req.method === 'request') {
        const requestOptions = req.args[0] as { headers?: Record<string, unknown> } | undefined;
        const referencesSecret = requestOptions?.headers
          ? Object.values(requestOptions.headers).some(
              (v) => typeof v === 'object' && v !== null && typeof (v as { secretRef?: unknown }).secretRef === 'string',
            )
          : false;
        if (referencesSecret) {
          return fail(
            `Scope "secrets.use" is not granted for module "${req.moduleId}" — required to reference a secret by name in net.request headers`,
          );
        }
      } else if (req.namespace === 'ai' && req.method === 'ask') {
        const askOptions = req.args[0] as { secretRef?: unknown } | undefined;
        if (typeof askOptions?.secretRef === 'string') {
          return fail(
            `Scope "secrets.use" is not granted for module "${req.moduleId}" — required to reference a secret by name in ai.ask`,
          );
        }
      }
    }

    // net.mock's extra `net.mock.debugger` gate (docs/ROADMAP.md Track B2b) — same shape of
    // argument-conditional check as secrets.use above, for the same reason: whether this call needs
    // it depends on THIS call's own options, not on `mock.add`'s fixed catalog scope. Runs
    // `chooseMechanismForScriptRule` — the exact same pure function `net-mock-host.ts`'s
    // `performMockAdd` will call to build the rule — so the mechanism this gate checks against can
    // never drift from the mechanism that actually gets persisted; net-mock-host.ts trusts this
    // check already happened and never re-verifies it (rpc-handler.ts is the one enforce point,
    // §3.4). `net.mock.debugger` reuses net.mock's own `resourceUrl` (already resolved above) since
    // it gates the SAME origin, not a second independent one.
    if (req.namespace === 'net' && req.method === 'mock.add') {
      const options = req.args[0] as { action?: unknown; rewriteBody?: unknown; matchAnyResourceType?: unknown } | undefined;
      const action = options?.action === 'rewrite-request' || options?.action === 'block' ? options.action : 'fake-response';
      const mechanism = chooseMechanismForScriptRule(action, {
        rewriteBody: options?.rewriteBody,
        matchAnyResourceType: options?.matchAnyResourceType === true,
      });
      if (mechanism === 'debugger' && !grantsAllow(granted, 'net.mock.debugger', resourceUrl)) {
        return fail(
          `Scope "net.mock.debugger" is required in addition to "net.mock" for module "${req.moduleId}" — ` +
            'this rule\'s action + hints resolve to the debugger mechanism',
        );
      }
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
