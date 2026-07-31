import type { ManifestSegment, ParsedManifest } from '../media-manifest-parser';

/**
 * docs/ROADMAP.md §7.4/§10.1/§11.2 — the two SEGMENT-SELECTION rules the engine applies to a freshly
 * (re)fetched manifest, extracted out of utils/download-engine.ts (Phase 1). Global SDK
 * (docs/design.md §9): pure decisions over an already-parsed manifest, no `fetch` — the engine still
 * owns fetching and parsing, this only says what may be USED from the result.
 *
 * Both rules exist for the same underlying reason, and getting either wrong corrupts the output
 * file silently rather than failing: a VOD playlist's index `i` names the same segment across
 * refetches, a LIVE playlist's does not (its window slides), so VOD may swap its segment array
 * wholesale by index while live must track segments by absolute media-sequence number.
 */

/**
 * docs/ROADMAP.md §7.4 — whether a re-fetched manifest may replace the working segment array
 * wholesale, by INDEX, mid-run (the recovery path for a signed segment URL that expired). Safe under
 * the concurrent pool because already-fetched-and-written indices are never re-read; only
 * not-yet-fetched ones observe the replacement. Refused for anything but a confirmed VOD media
 * playlist that still lists at least as far as `fromIndex`.
 */
export function segmentsForIndexRemap(reparsed: ParsedManifest, fromIndex: number): ManifestSegment[] | undefined {
  if (reparsed.kind !== 'media' || reparsed.isLive || reparsed.segments.length <= fromIndex) return undefined;
  return reparsed.segments;
}

export interface PendingLiveSegment {
  /** Absolute HLS media-sequence number (`manifest.mediaSequence + i`) — the only stable identity a
   * segment has across polls of a sliding-window playlist. Also the IV source for AES-128. */
  sequence: number;
  segment: ManifestSegment;
}

/**
 * docs/ROADMAP.md §10.1 — everything the CURRENT poll lists that hasn't been captured yet, oldest
 * first. Segments already captured (sequence below `nextSequenceToFetch`) are skipped; a window that
 * slid past `nextSequenceToFetch` entirely simply yields everything it still has, which is the
 * correct behaviour — those segments are genuinely gone from the origin and no amount of waiting
 * brings them back.
 */
export function selectPendingLiveSegments(
  manifest: Extract<ParsedManifest, { kind: 'media' }>,
  nextSequenceToFetch: number,
): PendingLiveSegment[] {
  const pending: PendingLiveSegment[] = [];
  for (let i = 0; i < manifest.segments.length; i++) {
    const sequence = manifest.mediaSequence + i;
    if (sequence < nextSequenceToFetch) continue;
    pending.push({ sequence, segment: manifest.segments[i]! });
  }
  return pending;
}

/** docs/ROADMAP.md §10.1 — HLS's own recommended re-poll cadence is the playlist's own
 * `#EXT-X-TARGETDURATION`; this fallback is only for a manifest that omits it. */
export const LIVE_POLL_FALLBACK_MS = 5000;

export function livePollDelayMs(targetDurationSec: number | undefined): number {
  return targetDurationSec ? targetDurationSec * 1000 : LIVE_POLL_FALLBACK_MS;
}
