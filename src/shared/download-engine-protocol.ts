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
   * downloader for a plain static file. `RESUME_CHECKPOINT` (§8.12) starts a NEW in-memory job that
   * continues a previously-interrupted HLS job from a persisted `DownloadJobCheckpoint` — distinct
   * from `RESUME`, which only un-pauses a job that's still alive in `jobs`. PAUSE/RESUME/CANCEL are
   * generic — they act on whichever `JobControl` is registered for `jobId` regardless of which
   * START variant created it. */
  op: 'START' | 'START_TURBO' | 'PAUSE' | 'RESUME' | 'CANCEL' | 'RESUME_CHECKPOINT';
  jobId: string;
  /** Only meaningful for START/START_TURBO — the manifest or file URL to download. Explicit
   * `| undefined` (not just `?`) — tsconfig's `exactOptionalPropertyTypes` requires it since callers
   * build this object with a possibly-undefined value rather than omitting the key outright. */
  url?: string | undefined;
  /** Only meaningful for START — cosmetic label (e.g. "1080p") carried through to a persisted
   * `DownloadJobCheckpoint` so a later "Resume available" row can show which resolution it belongs
   * to, without the engine needing to know anything about resolutions itself. */
  resolutionLabel?: string | undefined;
  /** Only meaningful for RESUME_CHECKPOINT — the checkpoint to resume from. The caller (Side Panel)
   * already had to load the checkpoint list from storage to decide whether to show a "Resume"
   * affordance at all, so it's cheapest to just hand the whole object back rather than round-trip
   * through background again to look it up by `jobId`. */
  checkpoint?: DownloadJobCheckpoint | undefined;
}

/**
 * docs/ROADMAP.md §8.12 — enough state to safely CONTINUE an interrupted HLS job, persisted
 * periodically (coalesced, not per-segment) to `chrome.storage.local` via
 * utils/download-job-checkpoints.ts. Deliberately does NOT carry the segment URL list itself — a
 * resume always refetches+reparses the manifest fresh (docs/ROADMAP.md §7.4's existing
 * refresh-on-401/403 logic, reused) since a signed-URL segment list can rot between sessions.
 * HLS-only: §8.2's turbo (multi-connection Range) jobs have no natural small checkpoint (a handful
 * of huge chunks, no per-chunk "already durably written" boundary worth persisting) and are not
 * checkpointed at all — see download-engine.ts's `runJob` for where this is written.
 */
export interface DownloadJobCheckpoint {
  jobId: string;
  manifestUrl: string;
  /** Which OPFS file (utils/opfs-store.ts's `RUN_DIR`) already holds the confirmed bytes. Resuming
   * means re-opening THIS SAME file and truncating it back to `lastConfirmedByteOffset` — never
   * starting a fresh one. */
  opfsRunId: string;
  /** 0-based index of the last segment (in the manifest's original order) that was durably written
   * to the OPFS file — resume starts fetching at `lastConfirmedSegmentIndex + 1`. */
  lastConfirmedSegmentIndex: number;
  /** The OPFS file's real byte length at the moment `lastConfirmedSegmentIndex` was confirmed —
   * resume trusts this ONLY after checking it against the file's actual current `size` on disk
   * (docs/ROADMAP.md §8.12: never trust the saved number blindly, a crash could have left the
   * checkpoint saved either earlier or later than what actually landed on disk). */
  lastConfirmedByteOffset: number;
  /** Segment count as of when this checkpoint was written — cosmetic only (a fresh manifest refetch
   * at resume time is the source of truth for the real total, which may differ slightly). */
  total: number;
  resolutionLabel?: string | undefined;
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
