import type { SynapseApi, SynapsePageApi, SynapsePipelineApi, SynapseUiApi } from '../../../kernel/synapse-api';
import { htmlToMarkdown } from '../../../shared/html-to-markdown';
import { isValidMatchPattern, matchesAnyPattern, matchesUrlPattern } from '../../../shared/match-pattern';
import { parseM3u8 } from '../../../shared/media-manifest-parser';
import { buildZip } from '../../../shared/zip';
import { performAiAsk } from './ai-ask-host';
import { performFilesSave } from './files-save-host';
import { readable } from './lib-readable';
import { onMediaProgressLocal, performMediaControl, performMediaDownload, performMediaInspect, performMediaJob, performMediaList } from './media-host';
import { performMockAdd, performMockList, performMockRemove } from './net-mock-host';
import { performNetRequest } from './net-request-host';
import { performPageEval } from './page-eval-host';
import { performHookRegister, performHookUnregister } from './pipeline-hook-store';
import { createScriptStorage } from './script-storage';

/** Second argument to `createSynapseApi` — context the transport itself knows and the caller cannot
 * fake, threaded in from `rpc-handler.ts`'s `sender` (for RPC callers) or left absent (for an
 * in-process bundled Module, which has no tab of its own). Kept separate from `moduleId` because it
 * describes WHERE the call came from, not WHO is calling. */
export interface SynapseApiContext {
  /** The tab `page.eval` should run in — absent for a background Module, which gets `backgroundPageStub`. */
  tabId?: number;
}

/** `lib.*` (docs/api-inventory.md §3.0) needs no injection trick here — this context is a plain
 * ESM module (the background service worker), so it just imports the real functions directly. The
 * `?script&iife` + `{file}` dance in `user-script-lib-payload.ts` exists ONLY for the USER_SCRIPT
 * world, which has no module loader; this transport was never that world. `readable`/`toMarkdown`
 * are real here too, not stubbed — a background Module calling `readable()` with no `doc` (there is
 * no page `document` in a service worker) fails with a plain `ReferenceError`, an honest failure for
 * a missing input rather than a crafted "unavailable" message. */
const lib = {
  hls: { parse: parseM3u8 },
  readable,
  toMarkdown: htmlToMarkdown,
  zip: buildZip,
  matchPattern: { isValid: isValidMatchPattern, test: matchesUrlPattern, testAny: matchesAnyPattern },
};

/**
 * The one real implementation of `synapseApi` (docs/ROADMAP.md §11.3). All three transports funnel
 * here rather than each building their own:
 *
 * - **in-process** — background Modules, via `ServiceInjector`'s `api` factory → `ctx.api`.
 * - **content-script RPC** — `content-scripts/rpc-client.ts` builds a proxy of the same interface;
 *   `rpc-handler.ts` resolves it against this.
 * - **user script shim** — the same RPC path, injected as `globalThis.synapseApi`.
 *
 * Scope enforcement is NOT here: it belongs at the trust boundary (`rpc-handler.ts`), which is the
 * only place that can tell an uploaded script from build-time code. Everything reachable from an
 * untrusted caller passes through that check first; in-process callers are build-time code that
 * could import the underlying store directly anyway, so a check there would be theatre.
 *
 * The namespacing in `script-storage.ts`, by contrast, applies to every caller including bundled
 * Modules — it isn't a permission check, it's what makes the store's keys unforgeable.
 */
/**
 * `ui` is the one namespace that is NOT transport-shaped but context-shaped: it renders into the
 * caller's own DOM, and both callers of `createSynapseApi` (the ServiceInjector factory for
 * background Modules, and `rpc-handler.ts`) live in the service worker, where there is none.
 *
 * A stub that throws with the reason, rather than a no-op or a silently absent namespace: a
 * background Module reaching for `ctx.api.ui` has a real design error (its UI belongs on a page,
 * see the `ui-surface-placement` skill), and the failure should say so. Code that DOES run on a page
 * gets the real compositor from `content-scripts/rpc-client.ts`.
 *
 * `rpc-handler.ts` never reaches this: `ui.*` is `transport: 'in-world'`, so `scopeForApiMethod`
 * refuses to resolve it and the call is rejected at the boundary before an implementation is looked
 * up at all.
 */
function backgroundUiStub(): SynapseUiApi {
  const unavailable = (): never => {
    throw new Error(
      'synapseApi.ui is only available to code running on a page. This Module runs in the ' +
        'background service worker, which has no DOM — surface it from a content-script Module, or ' +
        'use the Side Panel / Dashboard instead.',
    );
  };
  return { toast: unavailable, icon: unavailable, badge: unavailable, dismiss: unavailable, clear: unavailable };
}

/** Same posture as `backgroundUiStub`, for the same reason: "the page's MAIN world" has no meaning
 * for code that isn't attached to any tab. A background Module calling `ctx.api.page.eval` has a
 * real design error, so the failure says so rather than silently no-op'ing or throwing a generic
 * "no tabId" error that reads like a platform bug. */
function backgroundPageStub(): SynapsePageApi {
  return {
    eval: () =>
      Promise.reject(
        new Error(
          'synapseApi.page.eval is only available to code running on a page. This Module runs in ' +
            'the background service worker, which has no tab of its own to run code in.',
        ),
      ),
  };
}

function pageApiFor(tabId: number | undefined): SynapsePageApi {
  if (tabId === undefined) return backgroundPageStub();
  return { eval: (code, args) => performPageEval(tabId, code, args) };
}

/** `register` is internal plumbing `pipeline.hook`'s shim code calls on the script's behalf
 * (`scopes.ts`'s `pipeline.register` catalog entry doc comment) — deliberately NOT part of the
 * public `SynapseApi`/`SynapsePipelineApi` type, only reachable via `rpc-handler.ts`'s untyped
 * `api[req.namespace]` reflection dispatch. */
interface PipelineApiInternal extends SynapsePipelineApi {
  register(slotName: string, options: { match: string[] }): Promise<void>;
  unregister(slotName: string): Promise<void>;
}

/** `hook` itself needs a real "own world" (a `window` to dispatch/listen for the fire/result
 * CustomEvent round trip) — meaningless for the background service worker, same reason
 * `backgroundUiStub`/`backgroundPageStub` exist. A background Module has no bundled-Module use case
 * for hooking a slot anyway (Tier 2 is for user scripts overriding the platform, not the platform
 * hooking itself), so this is a throwing stub, not a real in-process implementation — `rpc-client.ts`
 * (dom Module) and `user-script-shim.ts` (uploaded script) each hand-roll their own real `hook`, the
 * same "every transport builds its own in-world thing" shape `ui`/`media.onProgress` already use. */
function pipelineApiFor(moduleId: string): PipelineApiInternal {
  return {
    hook: () =>
      Promise.reject(
        new Error(
          "synapseApi.pipeline.hook runs only inside a script's own world (content-script or " +
            'uploaded-script transport) — not reachable in-process from a background Module.',
        ),
      ),
    register: (slotName, options) => performHookRegister(moduleId, slotName, options),
    unregister: (slotName) => performHookUnregister(moduleId, slotName),
  };
}

export function createSynapseApi(moduleId: string, context: SynapseApiContext = {}): SynapseApi {
  return {
    storage: createScriptStorage(moduleId, context.tabId),
    ui: backgroundUiStub(),
    net: {
      request: performNetRequest,
      mock: {
        add: (options) => performMockAdd(moduleId, options),
        remove: (id) => performMockRemove(moduleId, id),
        list: () => performMockList(moduleId),
      },
    },
    files: { save: performFilesSave },
    lib,
    media: {
      list: () => performMediaList(),
      inspect: (url) => performMediaInspect(url),
      download: (options) => performMediaDownload(options, context.tabId),
      job: (jobId) => performMediaJob(jobId),
      control: (jobId, action) => performMediaControl(jobId, action),
      // Real, working implementation for the in-process (background-Module) transport — no world
      // boundary to cross here, so it needs no spike (see media-host.ts's own doc comment on
      // onMediaProgressLocal). The content-script and USER_SCRIPT transports each carry their OWN
      // implementation instead of calling through here (rpc-client.ts, user-script-shim.ts) — same
      // "every transport builds its own in-world thing" shape `ui` already established, because
      // `onProgress` never crosses the RPC boundary this file backs (docs/api-inventory.md §6 item 8).
      onProgress: (jobId, handler) => onMediaProgressLocal(jobId, handler),
    },
    page: pageApiFor(context.tabId),
    ai: { ask: performAiAsk },
    pipeline: pipelineApiFor(moduleId),
  };
}
