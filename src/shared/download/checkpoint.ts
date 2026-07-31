import type { DownloadJobCheckpoint } from '../download-engine-protocol';
import type { ParsedManifest, SegmentKey } from '../media-manifest-parser';
import { describeDrmKey, findRealDrmSegment } from './hls-crypto';

/**
 * docs/ROADMAP.md §8.12/§11.2 — the checkpoint SHAPE plus the "may this checkpoint be resumed?"
 * decision, extracted out of utils/download-engine.ts (Phase 1: "shape checkpoint → shared/").
 * Global SDK (docs/design.md §9): pure — no `chrome.storage`, no OPFS. Persistence lives in
 * features/media/download/checkpoints.ts, and the OPFS file's real size (the OTHER half of the
 * resume decision, and the one that can't be reasoned about without touching disk) is still checked
 * separately by `tryResumeOpfsRun`.
 *
 * A checkpoint is a HINT for where to resume, never a fact taken on faith — every refusal below is
 * a case where the manifest moved on too much (or too little) since the checkpoint was written to
 * trust a byte-for-byte continuation, and each carries the message the user actually sees.
 */

export interface CheckpointDraft {
  jobId: string;
  manifestUrl: string;
  opfsRunId: string;
  /** Count of segments confirmed durably written, NOT an index — the conversion to
   * `lastConfirmedSegmentIndex` (which is 0-based, hence `- 1`) happens here exactly once instead of
   * at each call site, where an off-by-one silently costs or duplicates one segment on resume. */
  segmentsDone: number;
  lastConfirmedByteOffset: number;
  total: number;
  resolutionLabel?: string | undefined;
}

export function buildCheckpoint(draft: CheckpointDraft): DownloadJobCheckpoint {
  return {
    jobId: draft.jobId,
    manifestUrl: draft.manifestUrl,
    opfsRunId: draft.opfsRunId,
    lastConfirmedSegmentIndex: draft.segmentsDone - 1,
    lastConfirmedByteOffset: draft.lastConfirmedByteOffset,
    total: draft.total,
    resolutionLabel: draft.resolutionLabel,
  };
}

/** 0-based index the next fetch must start from. */
export function resumeStartIndex(checkpoint: DownloadJobCheckpoint): number {
  return checkpoint.lastConfirmedSegmentIndex + 1;
}

export type ResumeEligibility =
  | { ok: true; manifest: Extract<ParsedManifest, { kind: 'media' }>; startIndex: number }
  | { ok: false; message: string };

/**
 * docs/ROADMAP.md §8.12 — the mandatory safety checks a freshly refetched manifest must pass before
 * a checkpoint may be continued. Deliberately returns a REASON rather than a boolean: every refusal
 * path in the engine has to emit an error explaining itself (and clear the checkpoint), or the user
 * is left staring at a "Resume" row that will never work again.
 */
export function evaluateResumeEligibility(manifest: ParsedManifest, checkpoint: DownloadJobCheckpoint): ResumeEligibility {
  if (manifest.kind !== 'media') {
    return { ok: false, message: 'This URL no longer looks like a resumable media playlist (it changed since the last attempt) — start a fresh download instead.' };
  }
  if (manifest.isLive) {
    return { ok: false, message: 'This is now a live/sliding-window stream — there is no fixed segment set to safely resume. Start a fresh download instead.' };
  }
  if (manifest.segments.length <= checkpoint.lastConfirmedSegmentIndex) {
    return { ok: false, message: 'The manifest now has fewer segments than were already downloaded — it changed too much to resume safely. Start a fresh download instead.' };
  }
  const drmKey = findRealDrmSegment(manifest.segments);
  if (drmKey) return { ok: false, message: drmRefusalMessage(drmKey) };
  return { ok: true, manifest, startIndex: resumeStartIndex(checkpoint) };
}

/** The single wording of the DRM refusal, shared by the start guard and the resume guard (live
 * capture's mid-stream guard words its own "became DRM-protected mid-capture" variant). */
export function drmRefusalMessage(key: SegmentKey): string {
  return `This stream is DRM-protected (${describeDrmKey(key)}). Synapse cannot and will not attempt to download or remux DRM-protected content.`;
}
