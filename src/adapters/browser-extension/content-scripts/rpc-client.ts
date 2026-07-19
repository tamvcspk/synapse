import type { Capability, ModuleContext } from '../../../kernel/module';
import type { RpcRequest, RpcResponse } from '../../../kernel/rpc';

/**
 * Content-script-side counterpart to module-registry/rpc-handler.ts — lets a bundled `dom`
 * Module reach background Kernel Services the same way an uploaded module's shim does
 * (user-script-shim.ts), instead of getting an empty ModuleContext (see relay.ts). 'bus' is
 * intentionally not proxied here: it's pub/sub, and a handler function can't cross
 * chrome.runtime.sendMessage's structured-clone boundary — a dom Module needing `bus` must still
 * hand-roll messaging itself (see the kernel-bootstrap skill's note on this).
 */
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (err: unknown) => void }>();

chrome.runtime.onMessage.addListener((message) => {
  if (!message || (message as { type?: unknown }).type !== 'synapse:rpc-result') return;
  const response = message as RpcResponse;
  const entry = pending.get(response.callId);
  if (!entry) return;
  pending.delete(response.callId);
  if (response.error) entry.reject(new Error(response.error));
  else entry.resolve(response.result);
});

function call(moduleId: string, service: 'ai' | 'cache', method: string, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const callId = crypto.randomUUID();
    pending.set(callId, { resolve, reject });
    const request: RpcRequest = { type: 'synapse:rpc', callId, moduleId, service, method, args };
    chrome.runtime.sendMessage(request);
  });
}

/** Builds ctx.services for a dom Module from its declared `needs`, backed by the RPC bridge. */
export function buildDomModuleServices(moduleId: string, needs: Capability[] = []): ModuleContext['services'] {
  const services: ModuleContext['services'] = {};
  if (needs.includes('ai')) {
    services.ai = { ask: (input) => call(moduleId, 'ai', 'ask', [input]) };
  }
  if (needs.includes('cache')) {
    services.cache = {
      get: (key) => call(moduleId, 'cache', 'get', [key]),
      set: (key, value) => call(moduleId, 'cache', 'set', [key, value]).then(() => undefined),
    };
  }
  return services;
}
