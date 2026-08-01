import type { RpcRequest, RpcResponse } from '../../../kernel/rpc';
import type { SynapseApi } from '../../../kernel/synapse-api';
import { createUiSurface } from '../utils/ui-compositor';

/**
 * Content-script-side transport for `synapseApi` (docs/ROADMAP.md §11.3) — the counterpart to
 * module-registry/rpc-handler.ts, and the same wire protocol the uploaded-script shim uses
 * (user-script-shim.ts). A bundled `dom` Module gets this as `ctx.api` (see relay.ts) so all three
 * transports expose one interface; a method present on one and missing from another is a contract
 * break, not a gap.
 *
 * The old `buildDomModuleServices` this replaces handed back `ai`/`cache` Kernel Services from the
 * retired Capability model. `bus` was never proxied here for a reason worth keeping in mind when
 * extending this file: a handler function cannot cross `chrome.runtime.sendMessage`'s
 * structured-clone boundary, so any future subscription must register its handler locally here and
 * only push serializable events across.
 */
/**
 * The reply arrives as `sendMessage`'s own resolved value — `rpc-handler.ts` answers with
 * `sendResponse()`, which resolves the sender's promise rather than broadcasting anything. This
 * file used to instead listen for an inbound `'synapse:rpc-result'` message that nothing ever
 * sends, so every call hung forever, silently, in both transports. Awaiting the promise is the fix.
 */
async function call(
  moduleId: string,
  namespace: RpcRequest['namespace'],
  method: string,
  args: unknown[],
): Promise<unknown> {
  const request: RpcRequest = { type: 'synapse:rpc', callId: crypto.randomUUID(), moduleId, namespace, method, args };
  const response = (await chrome.runtime.sendMessage(request)) as RpcResponse | undefined;
  if (!response) throw new Error('Synapse: no response from the extension background (was it reloaded?)');
  if (response.error) throw new Error(response.error);
  return response.result;
}

/** Builds `ctx.api` for a bundled dom Module, backed by the RPC bridge. Calls are still checked
 * against the Module's granted scopes in background — a content script is not a trust boundary.
 *
 * `ui` is the exception that proves the shape: it does NOT go over the bridge (docs/ROADMAP.md
 * §11.0 — an engine behind a message boundary cannot take `onClick`), so it is wired straight to the
 * in-world compositor here, with the same `moduleId` this function was given. Identity still comes
 * from the caller of THIS function (the composition root), never from the Module's own code. */
export function buildDomModuleApi(moduleId: string): SynapseApi {
  return {
    storage: {
      get: (key) => call(moduleId, 'storage', 'get', [key]),
      set: (key, value) => call(moduleId, 'storage', 'set', [key, value]).then(() => undefined),
      remove: (key) => call(moduleId, 'storage', 'remove', [key]).then(() => undefined),
      keys: () => call(moduleId, 'storage', 'keys', []) as Promise<string[]>,
    },
    ui: createUiSurface(moduleId),
  };
}
