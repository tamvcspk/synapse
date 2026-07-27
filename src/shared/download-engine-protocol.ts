/**
 * docs/ROADMAP.md §8.1/§8.2 — type-only contract between whichever UI surface starts a download
 * (Side Panel, Dashboard's smart-download) and the engine that actually runs it
 * (utils/download-engine.ts, hosted in the singleton Offscreen Document). Global SDK (§9): no
 * chrome.* here, just types, so both privileged UI pages and the offscreen page import the exact
 * same shape.
 *
 * One event shape with a `phase` discriminator, not separate PROGRESS/COMPLETE/ERROR message
 * kinds — matches the existing `synapse:merge-progress` shape it replaces and every other
 * message-passing convention in this codebase (flat type string, no central dispatcher). Two job
 * kinds share this one protocol (`START` for HLS, `START_TURBO` for §8.2's opt-in multi-connection
 * direct-file downloader) — `segmentsDone`/`segmentsTotal`/`bytesPerSec`/`etaMs` were never actually
 * HLS-specific in meaning (just "N of M units done" + observed throughput), so §8.2 reuses them
 * as-is for chunk counts rather than inventing parallel field names.
 */

/** `'pausing'` sits between a PAUSE command and the engine actually reaching a quiet point — up to
 * one fetch per worker/chunk can still be genuinely in flight when PAUSE arrives and will still run
 * to completion (and still get written), so reporting `'paused'` immediately would be a lie the UI
 * has no way to tell apart from the truth. The engine only emits `'paused'` once every in-flight
 * fetch has actually settled (see utils/download-engine.ts's `noteFetchSettled`). */
export type DownloadEnginePhase = 'segments' | 'chunks' | 'remux' | 'pausing' | 'paused' | 'done' | 'error' | 'cancelled';

export interface DownloadEngineCommand {
  type: 'synapse:download-engine-command';
  /** `START` = HLS manifest job (§8.1). `START_TURBO` = §8.2's opt-in multi-connection Range
   * downloader for a plain static file. PAUSE/RESUME/CANCEL are generic — they act on whichever
   * `JobControl` is registered for `jobId` regardless of which START variant created it. */
  op: 'START' | 'START_TURBO' | 'PAUSE' | 'RESUME' | 'CANCEL';
  jobId: string;
  /** Only meaningful for START/START_TURBO — the manifest or file URL to download. Explicit
   * `| undefined` (not just `?`) — tsconfig's `exactOptionalPropertyTypes` requires it since callers
   * build this object with a possibly-undefined value rather than omitting the key outright. */
  url?: string | undefined;
}

/**
 * Bugfix: background/index.ts used to relay a `DownloadEngineCommand` by resending the EXACT same
 * message (same `type`) via `chrome.runtime.sendMessage`. `sendMessage` broadcasts to every
 * listening context, not just background — so once the singleton Offscreen Document already exists
 * (i.e. any download after the first one in a session), its own listener received the Side Panel's
 * ORIGINAL broadcast directly AND background's relayed re-broadcast a moment later: the same START
 * command landed twice. The in-memory `jobs` Map guard in `handleEngineCommand`/`startJob` happened
 * to swallow the duplicate `START` cleanly, but the double-send is real ambient noise that isn't
 * safe to rely on being harmless for every op forever (confirmed as the trigger for a real OPFS race
 * — see download-engine.ts's `createOpfsRun` running twice for the same tick). This distinct type is
 * ONLY ever sent by background's relay and ONLY ever listened for by the offscreen document
 * (ui/offscreen/main.ts) — the offscreen page no longer listens for the client-facing
 * `synapse:download-engine-command` type at all, so it structurally cannot receive the original
 * broadcast a second time.
 */
export interface DownloadEngineRelayedCommand extends Omit<DownloadEngineCommand, 'type'> {
  type: 'synapse:download-engine-command-relayed';
}

export interface DownloadEngineEvent {
  type: 'synapse:download-engine-event';
  jobId: string;
  phase: DownloadEnginePhase;
  segmentsDone?: number | undefined;
  segmentsTotal?: number | undefined;
  /** Both are estimates derived from this job's own observed throughput so far (elapsed time and
   * bytes downloaded since it started) — HLS manifests give segment duration, not byte size, so
   * there's no way to know the true total upfront (and §8.2's turbo downloader deliberately doesn't
   * bother computing an exact one either, for consistency). UI must show `etaMs` as a "~"
   * approximation, never as a precise countdown. */
  bytesPerSec?: number | undefined;
  etaMs?: number | undefined;
  message?: string | undefined;
}
