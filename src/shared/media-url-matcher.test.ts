import { describe, expect, it } from 'vitest';
import { classifyMediaMimeType, classifyMediaUrl } from './media-url-matcher';

describe('classifyMediaUrl', () => {
  it('classifies video, audio and stream-manifest extensions', () => {
    expect(classifyMediaUrl('https://example.com/clip.mp4')).toBe('video');
    expect(classifyMediaUrl('https://example.com/clip.webm')).toBe('video');
    expect(classifyMediaUrl('https://example.com/song.mp3')).toBe('audio');
    expect(classifyMediaUrl('https://example.com/song.flac')).toBe('audio');
    expect(classifyMediaUrl('https://example.com/master.m3u8')).toBe('stream');
    expect(classifyMediaUrl('https://example.com/manifest.mpd')).toBe('stream');
  });

  it('deliberately does NOT match HLS/DASH segment extensions', () => {
    // One stream fires hundreds of these; none is independently useful (docs/ROADMAP.md #4).
    expect(classifyMediaUrl('https://example.com/seg00042.ts')).toBeUndefined();
    expect(classifyMediaUrl('https://example.com/seg00042.m4s')).toBeUndefined();
  });

  it('reads the extension from the path only, ignoring query and hash', () => {
    expect(classifyMediaUrl('https://example.com/clip.mp4?token=abc&expires=1')).toBe('video');
    expect(classifyMediaUrl('https://example.com/clip.mp4#t=10')).toBe('video');
    // A media-looking extension in the QUERY is not a media URL.
    expect(classifyMediaUrl('https://example.com/player?src=clip.mp4')).toBeUndefined();
  });

  it('matches case-insensitively', () => {
    expect(classifyMediaUrl('https://example.com/CLIP.MP4')).toBe('video');
    expect(classifyMediaUrl('https://example.com/MASTER.M3U8')).toBe('stream');
  });

  it('returns undefined for extensionless, non-media, and unparsable URLs', () => {
    expect(classifyMediaUrl('https://example.com/stream')).toBeUndefined();
    expect(classifyMediaUrl('https://example.com/app.js')).toBeUndefined();
    expect(classifyMediaUrl('https://example.com/')).toBeUndefined();
    expect(classifyMediaUrl('not-a-url')).toBeUndefined();
    expect(classifyMediaUrl('')).toBeUndefined();
  });

  it('does not mistake a dot in a directory name for an extension', () => {
    expect(classifyMediaUrl('https://example.com/v1.2/stream')).toBeUndefined();
  });
});

describe('classifyMediaMimeType', () => {
  it('prefix-matches video/* and audio/* rather than an exhaustive codec list', () => {
    expect(classifyMediaMimeType('video/mp4')).toBe('video');
    expect(classifyMediaMimeType('video/x-matroska')).toBe('video');
    expect(classifyMediaMimeType('audio/mpeg')).toBe('audio');
    expect(classifyMediaMimeType('audio/aac')).toBe('audio');
  });

  it('classifies HLS/DASH manifest MIME types as stream', () => {
    expect(classifyMediaMimeType('application/vnd.apple.mpegurl')).toBe('stream');
    expect(classifyMediaMimeType('application/x-mpegURL')).toBe('stream');
    expect(classifyMediaMimeType('application/dash+xml')).toBe('stream');
    // Confirmed in the wild: GCS serving a plain .m3u8 with no HLS-specific override.
    expect(classifyMediaMimeType('audio/mpegurl')).toBe('stream');
  });

  it('excludes video/mp2t — the HLS segment MIME type — despite its video/ prefix', () => {
    expect(classifyMediaMimeType('video/mp2t')).toBeUndefined();
    expect(classifyMediaMimeType('video/mp2t; charset=utf-8')).toBeUndefined();
  });

  it('ignores parameters and surrounding whitespace', () => {
    expect(classifyMediaMimeType('video/mp4; codecs="avc1.42E01E"')).toBe('video');
    expect(classifyMediaMimeType('  VIDEO/MP4  ')).toBe('video');
  });

  it('returns undefined for non-media and empty content types', () => {
    expect(classifyMediaMimeType('application/json')).toBeUndefined();
    expect(classifyMediaMimeType('text/html')).toBeUndefined();
    expect(classifyMediaMimeType('application/octet-stream')).toBeUndefined();
    expect(classifyMediaMimeType('')).toBeUndefined();
  });
});
