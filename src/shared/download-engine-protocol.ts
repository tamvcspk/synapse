/**
 * docs/ROADMAP.md §8.1 — type-only contract between whichever UI surface starts an HLS
 * merge/download (Side Panel, Dashboard's smart-download) and the engine that actually runs it
 * (utils/download-engine.ts, hosted in the singleton Offscreen Document). Global SDK (§9): no
 * chrome.* here, just types, so both privileged UI pages and the offscreen page import the exact
 * same shape.
 *
 * One event shape with a `phase` discriminator, not separate PROGRESS/COMPLETE/ERROR message
 * kinds — matches the existing `synapse:merge-progress` shape it replaces and every other
 * message-passing convention in this codebase (flat type string, no central dispatcher).
 */

export type DownloadEnginePhase = 'segments' | 'remux' | 'done' | 'error' | 'paused' | 'cancelled';

export interface DownloadEngineCommand {
  type: 'synapse:download-engine-command';
  op: 'START' | 'PAUSE' | 'RESUME' | 'CANCEL';
  jobId: string;
  /** Only meaningful for START — the manifest URL to download. Explicit `| undefined` (not just
   * `?`) — tsconfig's `exactOptionalPropertyTypes` requires it since callers build this object with
   * a possibly-undefined value rather than omitting the key outright. */
  url?: string | undefined;
}

export interface DownloadEngineEvent {
  type: 'synapse:download-engine-event';
  jobId: string;
  phase: DownloadEnginePhase;
  segmentsDone?: number | undefined;
  segmentsTotal?: number | undefined;
  /** Both are estimates derived from this job's own observed throughput so far (elapsed time and
   * bytes downloaded since it started) — HLS manifests give segment duration, not byte size, so
   * there's no way to know the true total upfront. UI must show `etaMs` as a "~" approximation,
   * never as a precise countdown. */
  bytesPerSec?: number | undefined;
  etaMs?: number | undefined;
  message?: string | undefined;
}
