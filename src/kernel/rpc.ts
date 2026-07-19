/**
 * Message contracts for the bridge that lets a Module running in an isolated execution world
 * (e.g. chrome.userScripts' USER_SCRIPT world) reach Kernel Services it cannot call directly.
 * This file is transport-agnostic — the concrete chrome.runtime.sendMessage wiring lives in the
 * browser-extension Adapter (shim + background rpc-handler).
 */

export interface RpcRequest {
  type: 'synapse:rpc';
  callId: string;
  moduleId: string;
  service: 'ai' | 'cache' | 'bus';
  method: string;
  args: unknown[];
}

export interface RpcResponse {
  type: 'synapse:rpc-result';
  callId: string;
  result?: unknown;
  error?: string;
}

/**
 * Sent once by an uploaded module's shim after evaluating the script, reporting what it found.
 * `moduleId` is the canonical registration id the extension assigned at upload time (known
 * before the script ever runs); `id` is the script's own self-declared __synapseModule.id,
 * informational only — it cannot be the routing key since it isn't known until after execution.
 */
export interface ManifestReport {
  type: 'synapse:manifest-report';
  moduleId: string;
  id?: string;
  needs?: unknown;
  supportedEnvs?: unknown;
  hasRun: boolean;
  runError?: string;
}
