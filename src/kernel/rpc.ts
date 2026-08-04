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
  /** Set either when the manifest's `run`/`steps` shape fails the shim's structural check (see
   * `user-script-shim.ts`'s `normalizeManifestSteps`, e.g. "declare either run or steps, not
   * both"), or when at least one step's `run()` threw during the most recent execution — either
   * way, `chrome-module-registry.ts`'s `buildUploadedEntry` surfaces this as the entry's `reason`
   * and marks it `invalid`. */
  runError?: string;
  /**
   * The pipeline's steps, normalized to one shape (docs/ROADMAP.md §12.3): a bare `run` becomes
   * `[{ id: 'main' }]`. Present only once the manifest passed the structural check (i.e. whenever
   * `hasRun` is `true`) — `chrome-module-registry.ts` projects this onto `RegistryEntry.subModules`,
   * reusing the same field the Studio sidebar and the bundled Composite Module's Dashboard Steps
   * view both already read.
   */
  steps?: { id: string; label?: string }[];
  /**
   * Outcome of the MOST RECENT run, one entry per step in `steps`' order — reported once the whole
   * pipeline settles, separately from the `hasRun`/`steps` report sent right after evaluation
   * (before any step has run). A step skipped via the per-step bypass (`RegistryEntry.subState`)
   * still gets an entry here (`skipped: true`) so the Studio sidebar can show it as skipped rather
   * than silently missing, exactly like a bundled Composite Module's bypass.
   */
  stepResults?: { id: string; ok: boolean; durationMs: number; error?: string; skipped?: boolean }[];
}

/**
 * Sent by an uploaded module's shim right before running its pipeline, to read the per-step
 * bypass map a user has set from the Studio sidebar (docs/ROADMAP.md §12.3) — the same
 * `RegistryEntry.subState` a bundled Composite Module's `createCompositeModule` already reads
 * directly from storage. An uploaded script's code runs in a page's USER_SCRIPT world with no
 * direct `chrome.storage` access, so this is a small request/response pair of its own rather than
 * a `synapseApi` namespace: it carries no user-facing permission, only the script's own opt-out of
 * its own already-declared steps, so it doesn't belong behind a scope check the way `synapse:rpc`
 * methods do.
 */
export interface SubStateQuery {
  type: 'synapse:sub-state-query';
  moduleId: string;
}

export interface SubStateQueryResponse {
  subState: Record<string, boolean>;
}

/**
 * Console output relayed from a Dry Run (docs/ROADMAP.md §12.5, "Run once on this tab") — sent by
 * `dry-run-shim.ts`'s console shadow, one message per `console.log`/`warn`/`error` call the injected
 * code makes. Routed through the background the same way `ManifestReport` is (a USER_SCRIPT world's
 * `chrome.runtime.sendMessage` only reaches `onUserScriptMessage`, never an extension page's own
 * `onMessage` directly) — `rpc-handler.ts` re-broadcasts it verbatim via `chrome.runtime.sendMessage`
 * so Studio's own `onMessage` listener can pick it up. `runId` lets Studio ignore a stale message
 * from a PREVIOUS run still in flight when a new one starts.
 */
export interface DryRunLogMessage {
  type: 'synapse:dry-run-log';
  runId: string;
  level: 'log' | 'warn' | 'error';
  text: string;
}

/**
 * The pipeline's outcome for a Dry Run — the throwaway counterpart of `ManifestReport`, deliberately
 * a SEPARATE message type rather than reusing it: a dry run's source may not even be saved yet, and
 * even when it is (editing an already-uploaded script), its result must never be persisted or mistaken
 * for the script's last CONFIRMED run (`chrome-module-registry.ts`'s `buildUploadedEntry` reads
 * `ManifestReport` to build the Studio steps sidebar/popup status from real registered runs only).
 */
export interface DryRunResultMessage {
  type: 'synapse:dry-run-result';
  runId: string;
  ok: boolean;
  error?: string;
  steps?: { id: string; ok: boolean; durationMs: number; error?: string; skipped?: boolean }[];
}
