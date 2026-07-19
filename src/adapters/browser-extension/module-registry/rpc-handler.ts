import type { ServiceInjector } from '../../../kernel/service-injector';
import type { ManifestReport, RpcRequest, RpcResponse } from '../../../kernel/rpc';
import { getActivationMap, getGrantsMap, setManifestReport } from './storage';

/**
 * Background-side authority for the userScripts RPC bridge. The shim (user-script-shim.ts)
 * is never trusted to self-limit — every capability call is re-checked here against persisted
 * activation + grant state before it's allowed to reach a real Service.
 */
export function registerRpcHandler(injector: ServiceInjector): void {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (isManifestReport(msg)) {
      void handleManifestReport(msg);
      return;
    }
    if (!isRpcRequest(msg)) return;
    handleRpc(msg, injector).then(sendResponse);
    return true;
  });
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

async function handleRpc(req: RpcRequest, injector: ServiceInjector): Promise<RpcResponse> {
  try {
    const [activation, grants] = await Promise.all([getActivationMap(), getGrantsMap()]);

    if (activation[req.moduleId] === false) {
      return { type: 'synapse:rpc-result', callId: req.callId, error: `Module "${req.moduleId}" is inactive` };
    }

    const granted = grants[req.moduleId] ?? [];
    if (!granted.includes(req.service)) {
      return {
        type: 'synapse:rpc-result',
        callId: req.callId,
        error: `Capability "${req.service}" is not granted for module "${req.moduleId}"`,
      };
    }

    const ctx = injector.resolve([req.service]);
    const service = ctx.services[req.service] as Record<string, (...args: unknown[]) => unknown> | undefined;
    const method = service?.[req.method];
    if (typeof method !== 'function') {
      return { type: 'synapse:rpc-result', callId: req.callId, error: `Unknown method "${req.service}.${req.method}"` };
    }

    const result = await method(...req.args);
    return { type: 'synapse:rpc-result', callId: req.callId, result };
  } catch (err) {
    return { type: 'synapse:rpc-result', callId: req.callId, error: err instanceof Error ? err.message : String(err) };
  }
}
