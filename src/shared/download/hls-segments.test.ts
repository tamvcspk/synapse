import { describe, expect, it } from 'vitest';
import type { ManifestSegment, ParsedManifest } from '../media-manifest-parser';
import { LIVE_POLL_FALLBACK_MS, livePollDelayMs, segmentsForIndexRemap, selectPendingLiveSegments } from './hls-segments';

type MediaManifest = Extract<ParsedManifest, { kind: 'media' }>;

function media(over: Partial<MediaManifest> = {}): MediaManifest {
  return { kind: 'media', segments: [], encrypted: false, isLive: false, mediaSequence: 0, ...over };
}

function segments(count: number, from = 0): ManifestSegment[] {
  return Array.from({ length: count }, (_, i) => ({ url: `https://cdn.example.com/seg-${from + i}.ts` }));
}

describe('segmentsForIndexRemap', () => {
  it('accepts a VOD media playlist that still reaches the triggering index', () => {
    const manifest = media({ segments: segments(10) });
    expect(segmentsForIndexRemap(manifest, 3)).toBe(manifest.segments);
    expect(segmentsForIndexRemap(manifest, 9)).toBe(manifest.segments);
  });

  it('refuses a LIVE playlist — index i does not name the same segment across refetches', () => {
    expect(segmentsForIndexRemap(media({ segments: segments(10), isLive: true }), 3)).toBeUndefined();
  });

  it('refuses a playlist that no longer reaches the triggering index', () => {
    expect(segmentsForIndexRemap(media({ segments: segments(3) }), 3)).toBeUndefined();
    expect(segmentsForIndexRemap(media({ segments: [] }), 0)).toBeUndefined();
  });

  it('refuses anything that is no longer a media playlist', () => {
    expect(segmentsForIndexRemap({ kind: 'unknown' }, 0)).toBeUndefined();
    expect(segmentsForIndexRemap({ kind: 'master', variants: [] }, 0)).toBeUndefined();
  });
});

describe('selectPendingLiveSegments', () => {
  it('numbers segments by ABSOLUTE media sequence, not array index', () => {
    const pending = selectPendingLiveSegments(media({ segments: segments(3), mediaSequence: 100, isLive: true }), 100);
    expect(pending.map((p) => p.sequence)).toEqual([100, 101, 102]);
    expect(pending[0]!.segment.url).toContain('seg-0');
  });

  it('skips what was already captured after the window slides forward', () => {
    // Poll 1 listed 100..102 and all three were captured (nextSequenceToFetch = 103). Poll 2's
    // window has slid to 101..104 — only 103 and 104 are genuinely new, even though by ARRAY index
    // 101 and 102 now sit where 100 and 101 used to.
    const poll2 = media({ segments: segments(4), mediaSequence: 101, isLive: true });
    const pending = selectPendingLiveSegments(poll2, 103);
    expect(pending.map((p) => p.sequence)).toEqual([103, 104]);
  });

  it('returns nothing when a poll brings no new segments', () => {
    expect(selectPendingLiveSegments(media({ segments: segments(3), mediaSequence: 100, isLive: true }), 103)).toEqual([]);
  });

  it('yields everything still listed when the window slid clean past the cursor', () => {
    // Segments 103..109 are gone from the origin for good; waiting cannot bring them back, so the
    // capture must continue from what is actually still served rather than stall.
    const pending = selectPendingLiveSegments(media({ segments: segments(2), mediaSequence: 110, isLive: true }), 103);
    expect(pending.map((p) => p.sequence)).toEqual([110, 111]);
  });
});

describe('livePollDelayMs', () => {
  it('paces off the playlist\'s own #EXT-X-TARGETDURATION', () => {
    expect(livePollDelayMs(6)).toBe(6000);
    expect(livePollDelayMs(2)).toBe(2000);
  });

  it('falls back when the tag is missing or zero', () => {
    expect(livePollDelayMs(undefined)).toBe(LIVE_POLL_FALLBACK_MS);
    expect(livePollDelayMs(0)).toBe(LIVE_POLL_FALLBACK_MS);
  });
});
