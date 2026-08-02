import type { SynapseApi, SynapseUiApi } from '../../../kernel/synapse-api';
import { htmlToMarkdown } from '../../../shared/html-to-markdown';
import { parseM3u8 } from '../../../shared/media-manifest-parser';
import { buildZip } from '../../../shared/zip';
import { performFilesSave } from './files-save-host';
import { readable } from './lib-readable';
import { performMockAdd, performMockList, performMockRemove } from './net-mock-host';
import { performNetRequest } from './net-request-host';
import { createScriptStorage } from './script-storage';

/** `lib.*` (docs/api-inventory.md §3.0) needs no injection trick here — this context is a plain
 * ESM module (the background service worker), so it just imports the real functions directly. The
 * `?script&iife` + `{file}` dance in `user-script-lib-payload.ts` exists ONLY for the USER_SCRIPT
 * world, which has no module loader; this transport was never that world. `readable`/`toMarkdown`
 * are real here too, not stubbed — a background Module calling `readable()` with no `doc` (there is
 * no page `document` in a service worker) fails with a plain `ReferenceError`, an honest failure for
 * a missing input rather than a crafted "unavailable" message. */
const lib = { hls: { parse: parseM3u8 }, readable, toMarkdown: htmlToMarkdown, zip: buildZip };

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

export function createSynapseApi(moduleId: string): SynapseApi {
  return {
    storage: createScriptStorage(moduleId),
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
  };
}
