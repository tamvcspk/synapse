import { describe, expect, it } from 'vitest';
import { parseM3u8 } from './media-manifest-parser';

const BASE = 'https://cdn.example.com/hls/720p/index.m3u8';

describe('parseM3u8 — classification', () => {
  it('classifies a master playlist by #EXT-X-STREAM-INF and resolves variant URIs against baseUrl', () => {
    const manifest = parseM3u8(
      [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
        '360p.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
        '/abs/720p.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"',
        'https://other.example.com/audio.m3u8',
      ].join('\n'),
      BASE,
    );

    expect(manifest.kind).toBe('master');
    if (manifest.kind !== 'master') return;
    expect(manifest.variants).toEqual([
      { url: 'https://cdn.example.com/hls/720p/360p.m3u8', resolution: '640x360' },
      { url: 'https://cdn.example.com/abs/720p.m3u8', resolution: '1280x720' },
      // Audio-only variant advertises no RESOLUTION — the field must be absent, not empty-string.
      { url: 'https://other.example.com/audio.m3u8' },
    ]);
  });

  it('classifies a media playlist by #EXTINF and resolves segment URIs against baseUrl', () => {
    const manifest = parseM3u8(
      ['#EXTM3U', '#EXTINF:6.0,', 'seg0.ts', '#EXTINF:6.0,', 'seg1.ts', '#EXT-X-ENDLIST'].join('\n'),
      BASE,
    );

    expect(manifest.kind).toBe('media');
    if (manifest.kind !== 'media') return;
    expect(manifest.segments.map((s) => s.url)).toEqual([
      'https://cdn.example.com/hls/720p/seg0.ts',
      'https://cdn.example.com/hls/720p/seg1.ts',
    ]);
    expect(manifest.encrypted).toBe(false);
  });

  it('returns kind "unknown" for text that is neither (no #EXTINF, no #EXT-X-STREAM-INF)', () => {
    expect(parseM3u8('<html><body>404</body></html>', BASE).kind).toBe('unknown');
    expect(parseM3u8('', BASE).kind).toBe('unknown');
  });
});

describe('parseM3u8 — live vs VOD (the gate download-engine checks before remapping by index)', () => {
  const media = (extra: string[]) => parseM3u8(['#EXTM3U', ...extra, '#EXTINF:6.0,', 'seg0.ts'].join('\n'), BASE);

  it('is live when #EXT-X-ENDLIST is absent', () => {
    const m = media([]);
    expect(m.kind === 'media' && m.isLive).toBe(true);
  });

  it('is VOD when #EXT-X-ENDLIST is present', () => {
    const m = parseM3u8(['#EXTM3U', '#EXTINF:6.0,', 'seg0.ts', '#EXT-X-ENDLIST'].join('\n'), BASE);
    expect(m.kind === 'media' && m.isLive).toBe(false);
  });

  it('treats PLAYLIST-TYPE:EVENT as still live even with an ENDLIST-less body', () => {
    const m = media(['#EXT-X-PLAYLIST-TYPE:EVENT']);
    expect(m.kind === 'media' && m.isLive).toBe(true);
  });

  it('treats PLAYLIST-TYPE:VOD without ENDLIST as live (conservative — ENDLIST is the real signal)', () => {
    const m = media(['#EXT-X-PLAYLIST-TYPE:VOD']);
    expect(m.kind === 'media' && m.isLive).toBe(true);
  });
});

describe('parseM3u8 — sequencing metadata', () => {
  it('reads #EXT-X-MEDIA-SEQUENCE, defaulting to 0 when the tag is absent', () => {
    const withTag = parseM3u8(['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:1200', '#EXTINF:6.0,', 'a.ts'].join('\n'), BASE);
    expect(withTag.kind === 'media' && withTag.mediaSequence).toBe(1200);

    const withoutTag = parseM3u8(['#EXTM3U', '#EXTINF:6.0,', 'a.ts'].join('\n'), BASE);
    expect(withoutTag.kind === 'media' && withoutTag.mediaSequence).toBe(0);
  });

  it('reads #EXT-X-TARGETDURATION and leaves it absent when the tag is missing or malformed', () => {
    const withTag = parseM3u8(['#EXTM3U', '#EXT-X-TARGETDURATION:8', '#EXTINF:6.0,', 'a.ts'].join('\n'), BASE);
    expect(withTag.kind === 'media' && withTag.targetDurationSec).toBe(8);

    const malformed = parseM3u8(['#EXTM3U', '#EXT-X-TARGETDURATION:abc', '#EXTINF:6.0,', 'a.ts'].join('\n'), BASE);
    expect(malformed.kind === 'media' && malformed.targetDurationSec).toBeUndefined();

    const missing = parseM3u8(['#EXTM3U', '#EXTINF:6.0,', 'a.ts'].join('\n'), BASE);
    expect(missing.kind === 'media' && missing.targetDurationSec).toBeUndefined();
  });
});

describe('parseM3u8 — #EXT-X-KEY (the AES-128-vs-real-DRM boundary)', () => {
  it('attaches the in-scope key to every following segment and rotates on a new tag', () => {
    const manifest = parseM3u8(
      [
        '#EXTM3U',
        '#EXT-X-KEY:METHOD=AES-128,URI="key1.bin",IV=0x0123456789abcdef0123456789abcdef',
        '#EXTINF:6.0,',
        'seg0.ts',
        '#EXTINF:6.0,',
        'seg1.ts',
        '#EXT-X-KEY:METHOD=AES-128,URI="key2.bin"',
        '#EXTINF:6.0,',
        'seg2.ts',
        '#EXT-X-ENDLIST',
      ].join('\n'),
      BASE,
    );

    expect(manifest.kind).toBe('media');
    if (manifest.kind !== 'media') return;
    expect(manifest.encrypted).toBe(true);
    // Segments 0 and 1 share the SAME key object — keys apply until the next tag, not per segment.
    expect(manifest.segments[0]!.key).toBe(manifest.segments[1]!.key);
    expect(manifest.segments[0]!.key).toEqual({
      method: 'AES-128',
      uri: 'https://cdn.example.com/hls/720p/key1.bin',
      iv: '0x0123456789abcdef0123456789abcdef',
    });
    expect(manifest.segments[2]!.key).toEqual({
      method: 'AES-128',
      uri: 'https://cdn.example.com/hls/720p/key2.bin',
    });
    // No IV= attribute — must stay ABSENT so the engine derives it from the media sequence number
    // per the HLS spec, rather than seeing an empty string it might treat as a real IV.
    expect(manifest.segments[2]!.key!.iv).toBeUndefined();
  });

  it('clears the key on METHOD=NONE, leaving later segments unencrypted', () => {
    const manifest = parseM3u8(
      [
        '#EXTM3U',
        '#EXT-X-KEY:METHOD=AES-128,URI="key1.bin"',
        '#EXTINF:6.0,',
        'seg0.ts',
        '#EXT-X-KEY:METHOD=NONE',
        '#EXTINF:6.0,',
        'seg1.ts',
      ].join('\n'),
      BASE,
    );

    if (manifest.kind !== 'media') throw new Error('expected media playlist');
    expect(manifest.segments[0]!.key).toBeDefined();
    expect(manifest.segments[1]!.key).toBeUndefined();
    // `encrypted` is "at least one segment has a key", not "all of them do".
    expect(manifest.encrypted).toBe(true);
  });

  it('preserves KEYFORMAT verbatim so the DRM guard can refuse (and log) what it saw', () => {
    const manifest = parseM3u8(
      [
        '#EXTM3U',
        '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://abc",KEYFORMAT="com.apple.streamingkeydelivery"',
        '#EXTINF:6.0,',
        'seg0.ts',
      ].join('\n'),
      BASE,
    );

    if (manifest.kind !== 'media') throw new Error('expected media playlist');
    expect(manifest.segments[0]!.key).toMatchObject({
      method: 'SAMPLE-AES',
      keyFormat: 'com.apple.streamingkeydelivery',
    });
  });

  it('keeps quoted attribute values containing commas intact (a URI with query params)', () => {
    const manifest = parseM3u8(
      [
        '#EXTM3U',
        '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k?a=1,2&b=3"',
        '#EXTINF:6.0,',
        'seg0.ts',
      ].join('\n'),
      BASE,
    );

    if (manifest.kind !== 'media') throw new Error('expected media playlist');
    expect(manifest.segments[0]!.key!.uri).toBe('https://keys.example.com/k?a=1,2&b=3');
  });
});

describe('parseM3u8 — #EXT-X-MAP init segment (fMP4)', () => {
  it('resolves the init segment URI and its BYTERANGE', () => {
    const manifest = parseM3u8(
      [
        '#EXTM3U',
        '#EXT-X-MAP:URI="init.mp4",BYTERANGE="1024@0"',
        '#EXTINF:6.0,',
        'seg0.m4s',
        '#EXT-X-ENDLIST',
      ].join('\n'),
      BASE,
    );

    if (manifest.kind !== 'media') throw new Error('expected media playlist');
    expect(manifest.initSegment).toEqual({
      url: 'https://cdn.example.com/hls/720p/init.mp4',
      byteRange: '1024@0',
    });
  });

  it('classifies as media on the strength of #EXT-X-MAP alone', () => {
    const manifest = parseM3u8(['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"'].join('\n'), BASE);
    expect(manifest.kind).toBe('media');
  });

  it('leaves initSegment absent for a plain MPEG-TS playlist (the .ts-not-.mp4 output signal)', () => {
    const manifest = parseM3u8(['#EXTM3U', '#EXTINF:6.0,', 'seg0.ts', '#EXT-X-ENDLIST'].join('\n'), BASE);
    expect(manifest.kind === 'media' && manifest.initSegment).toBeUndefined();
  });
});

describe('parseM3u8 — resilience', () => {
  it('binds a bare URI to its tag even across intervening tags it does not otherwise act on', () => {
    const manifest = parseM3u8(
      [
        '#EXTM3U',
        '#EXTINF:6.0,',
        '#EXT-X-DISCONTINUITY',
        '#EXT-X-PROGRAM-DATE-TIME:2026-07-31T00:00:00Z',
        'seg0.ts',
        '#EXT-X-ENDLIST',
      ].join('\n'),
      BASE,
    );

    if (manifest.kind !== 'media') throw new Error('expected media playlist');
    expect(manifest.segments.map((s) => s.url)).toEqual(['https://cdn.example.com/hls/720p/seg0.ts']);
  });

  it('degrades to an empty segment list rather than throwing when baseUrl itself is unusable', () => {
    // Every relative URI resolution fails here, but the parser must still return a classified
    // manifest — callers upstream report "no segments" far more usefully than a thrown parse error.
    const manifest = parseM3u8(
      ['#EXTM3U', '#EXTINF:6.0,', 'seg0.ts', '#EXTINF:6.0,', 'seg1.ts', '#EXT-X-ENDLIST'].join('\n'),
      'not-a-url',
    );

    expect(manifest.kind).toBe('media');
    if (manifest.kind !== 'media') return;
    expect(manifest.segments).toHaveLength(0);
  });

  it('tolerates CRLF line endings and blank lines', () => {
    const manifest = parseM3u8('#EXTM3U\r\n\r\n#EXTINF:6.0,\r\nseg0.ts\r\n#EXT-X-ENDLIST\r\n', BASE);
    if (manifest.kind !== 'media') throw new Error('expected media playlist');
    expect(manifest.segments.map((s) => s.url)).toEqual(['https://cdn.example.com/hls/720p/seg0.ts']);
  });
});
