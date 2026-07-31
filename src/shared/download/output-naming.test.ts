import { describe, expect, it } from 'vitest';
import { fileNameFromUrl, outputFileName } from './output-naming';

describe('fileNameFromUrl', () => {
  it('takes the last path segment and strips a trailing .m3u8', () => {
    expect(fileNameFromUrl('https://cdn.example.com/videos/lecture-01.m3u8')).toBe('lecture-01');
    expect(fileNameFromUrl('https://cdn.example.com/videos/movie.mp4')).toBe('movie.mp4');
  });

  it('ignores query strings and fragments (they are not part of the pathname)', () => {
    expect(fileNameFromUrl('https://cdn.example.com/v/master.m3u8?token=abc&exp=123')).toBe('master');
  });

  it('returns empty for a directory-style URL or an unparsable one, leaving the fallback to the caller', () => {
    expect(fileNameFromUrl('https://cdn.example.com/videos/')).toBe('');
    expect(fileNameFromUrl('not a url')).toBe('');
    expect(fileNameFromUrl('')).toBe('');
  });
});

describe('outputFileName', () => {
  it('slugifies the stream name and appends the container the bytes already are', () => {
    expect(outputFileName('https://cdn.example.com/v/Lecture-01.m3u8', 'mp4')).toBe('lecture-01.mp4');
    expect(outputFileName('https://cdn.example.com/v/stream_720p.m3u8', 'ts')).toBe('stream-720p.ts');
  });

  it('carries percent-encoding through as literal characters (URL.pathname never decodes)', () => {
    // Documenting real behaviour, not endorsing it: a space in the source URL reaches slugify as
    // `%20`, so the saved file is named `...-20-...`. Cosmetic only — it has never affected which
    // bytes get downloaded — but it is what a user sees, so it should change deliberately if ever.
    expect(outputFileName('https://cdn.example.com/v/Lecture 01.m3u8', 'mp4')).toBe('lecture-2001.mp4');
  });

  it('falls back to "stream" when the URL yields no usable name', () => {
    expect(outputFileName('not a url', 'ts')).toBe('stream.ts');
    expect(outputFileName('https://cdn.example.com/---.m3u8', 'mp4')).toBe('stream.mp4');
  });
});
