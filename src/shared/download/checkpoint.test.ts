import { describe, expect, it } from 'vitest';
import type { DownloadJobCheckpoint } from '../download-engine-protocol';
import type { ManifestSegment, ParsedManifest } from '../media-manifest-parser';
import { buildCheckpoint, drmRefusalMessage, evaluateResumeEligibility, resumeStartIndex } from './checkpoint';

type MediaManifest = Extract<ParsedManifest, { kind: 'media' }>;

function media(over: Partial<MediaManifest> = {}): MediaManifest {
  return { kind: 'media', segments: [], encrypted: false, isLive: false, mediaSequence: 0, ...over };
}

function segments(count: number): ManifestSegment[] {
  return Array.from({ length: count }, (_, i) => ({ url: `https://cdn.example.com/seg-${i}.ts` }));
}

function checkpoint(over: Partial<DownloadJobCheckpoint> = {}): DownloadJobCheckpoint {
  return {
    jobId: 'job-1',
    manifestUrl: 'https://cdn.example.com/v/master.m3u8',
    opfsRunId: 'run-1',
    lastConfirmedSegmentIndex: 9,
    lastConfirmedByteOffset: 1024,
    total: 50,
    ...over,
  };
}

describe('buildCheckpoint', () => {
  it('converts a segments-DONE count into a 0-based last-confirmed INDEX', () => {
    const built = buildCheckpoint({
      jobId: 'job-1',
      manifestUrl: 'https://cdn.example.com/v/master.m3u8',
      opfsRunId: 'run-1',
      segmentsDone: 10,
      lastConfirmedByteOffset: 4096,
      total: 50,
      resolutionLabel: '1080p',
    });
    expect(built.lastConfirmedSegmentIndex).toBe(9);
    // Round-trip: the checkpoint just built must resume at exactly the next segment, no gap, no
    // repeat — the off-by-one this conversion exists to hold in one place.
    expect(resumeStartIndex(built)).toBe(10);
    expect(built.resolutionLabel).toBe('1080p');
  });

  it('records -1 when nothing has been confirmed yet, so a resume starts at segment 0', () => {
    const built = buildCheckpoint({ jobId: 'j', manifestUrl: 'u', opfsRunId: 'r', segmentsDone: 0, lastConfirmedByteOffset: 0, total: 5 });
    expect(built.lastConfirmedSegmentIndex).toBe(-1);
    expect(resumeStartIndex(built)).toBe(0);
  });
});

describe('evaluateResumeEligibility', () => {
  it('accepts a VOD playlist that still lists past the confirmed index', () => {
    const manifest = media({ segments: segments(50) });
    const result = evaluateResumeEligibility(manifest, checkpoint());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest).toBe(manifest);
      expect(result.startIndex).toBe(10);
    }
  });

  it('accepts a playlist that grew or shrank but still covers the confirmed index', () => {
    expect(evaluateResumeEligibility(media({ segments: segments(80) }), checkpoint()).ok).toBe(true);
    expect(evaluateResumeEligibility(media({ segments: segments(11) }), checkpoint()).ok).toBe(true);
  });

  it('refuses a URL that is no longer a media playlist', () => {
    const result = evaluateResumeEligibility({ kind: 'master', variants: [] }, checkpoint());
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toContain('no longer looks like a resumable media playlist');
  });

  it('refuses a stream that has since gone live — there is no fixed segment set to continue', () => {
    const result = evaluateResumeEligibility(media({ segments: segments(50), isLive: true }), checkpoint());
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toContain('live/sliding-window');
  });

  it('refuses a manifest that now has FEWER segments than were already downloaded', () => {
    // 10 confirmed (index 9), manifest now lists 10 → index 9 is its last, nothing left to resume
    // INTO, and the file on disk may not correspond to it at all.
    const result = evaluateResumeEligibility(media({ segments: segments(9) }), checkpoint());
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toContain('fewer segments');
  });

  it('refuses real DRM appearing anywhere in the refetched playlist', () => {
    const drmSegments = segments(50);
    drmSegments[30] = { url: 'https://cdn.example.com/seg-30.ts', key: { method: 'SAMPLE-AES', uri: 'skd://x' } };
    const result = evaluateResumeEligibility(media({ segments: drmSegments }), checkpoint());
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toContain('DRM-protected');
  });

  it('does NOT refuse plain AES-128, which the engine decrypts transparently', () => {
    const aesSegments = segments(50).map((s) => ({ ...s, key: { method: 'AES-128', uri: 'https://cdn.example.com/key.bin' } }));
    expect(evaluateResumeEligibility(media({ segments: aesSegments, encrypted: true }), checkpoint()).ok).toBe(true);
  });
});

describe('drmRefusalMessage', () => {
  it('names what was actually seen', () => {
    expect(drmRefusalMessage({ method: 'SAMPLE-AES', uri: 'skd://x' })).toContain('METHOD=SAMPLE-AES');
    expect(drmRefusalMessage({ method: 'AES-128', uri: 'x', keyFormat: 'com.widevine.alpha' })).toContain('KEYFORMAT=com.widevine.alpha');
  });
});
