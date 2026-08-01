/**
 * Message contracts for the bridge that lets a Module running in an isolated execution world
 * (e.g. chrome.userScripts' USER_SCRIPT world) reach the `synapseApi` implementation it cannot call
 * directly. This file is transport-agnostic — the concrete chrome.runtime.sendMessage wiring lives
 * in the browser-extension Adapter (shim + background rpc-handler).
 */

import type { SynapseApi } from './synapse-api';

export interface RpcRequest {
  type: 'synapse:rpc';
  callId: string;
  /**
   * The canonical registration id the extension assigned — NOT anything the script declared about
   * itself. Note the standing limitation this shares with every `chrome.runtime` sender check:
   * `sender` identifies a frame, not a script, so a uploaded script that bypasses its own shim and
   * messages the background directly can put any id here. That is why bundled Modules' derived
   * grants are kept as small as they actually need to be (docs/ROADMAP.md Open Points).
   */
  moduleId: string;
  /** A namespace of `SynapseApi` (`'storage'`), not a Kernel Service name. The old
   * `'ai' | 'cache' | 'bus'` routing is gone with the Capability model (docs/ROADMAP.md §11.3):
   * `cache` was an unnamespaced `chrome.storage.local` and therefore a privilege-escalation
   * primitive, and `bus` could never be granted honestly. */
  namespace: keyof SynapseApi;
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
  /** The script's self-declared `scopes` — a *request*, validated and then shown in the consent
   * UI. Never authorization on its own (the stored grant record is). */
  scopes?: unknown;
  hasRun: boolean;
  runError?: string;
}
