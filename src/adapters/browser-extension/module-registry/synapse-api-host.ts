import type { SynapseApi } from '../../../kernel/synapse-api';
import { createScriptStorage } from './script-storage';

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
export function createSynapseApi(moduleId: string): SynapseApi {
  return {
    storage: createScriptStorage(moduleId),
  };
}
