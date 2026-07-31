import { describe, expect, it } from 'vitest';
import { looksLikeSignedUrl } from './signed-url-detector';

describe('looksLikeSignedUrl', () => {
  it('detects the common signed/expiring query keys', () => {
    expect(looksLikeSignedUrl('https://cdn.example.com/v.mp4?expires=1782000000')).toBe(true);
    expect(looksLikeSignedUrl('https://cdn.example.com/v.mp4?token=abc123')).toBe(true);
    expect(looksLikeSignedUrl('https://cdn.example.com/v.mp4?sig=deadbeef')).toBe(true);
    expect(looksLikeSignedUrl('https://cdn.example.com/v.mp4?hmac=xyz')).toBe(true);
    expect(looksLikeSignedUrl('https://cdn.example.com/v.mp4?policy=eyJ')).toBe(true);
  });

  it('detects S3/CloudFront presigned parameters', () => {
    const presigned =
      'https://bucket.s3.amazonaws.com/v.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&X-Amz-Signature=abc';
    expect(looksLikeSignedUrl(presigned)).toBe(true);
  });

  it('matches key names case-insensitively and regardless of position', () => {
    expect(looksLikeSignedUrl('https://cdn.example.com/v.mp4?TOKEN=abc')).toBe(true);
    expect(looksLikeSignedUrl('https://cdn.example.com/v.mp4?quality=hd&Expires=1')).toBe(true);
  });

  it('matches the short keys only as whole key names, never as a substring of another key', () => {
    expect(looksLikeSignedUrl('https://cdn.example.com/v.mp4?e=1782000000')).toBe(true);
    expect(looksLikeSignedUrl('https://cdn.example.com/v.mp4?st=1782000000')).toBe(true);
    // 'episode'/'start' contain 'e'/'st' but are not signature keys.
    expect(looksLikeSignedUrl('https://cdn.example.com/v.mp4?episode=4')).toBe(false);
    expect(looksLikeSignedUrl('https://cdn.example.com/v.mp4?start=30')).toBe(false);
  });

  it('is false for unsigned URLs, and for signature-looking text outside the query string', () => {
    expect(looksLikeSignedUrl('https://cdn.example.com/v.mp4')).toBe(false);
    expect(looksLikeSignedUrl('https://cdn.example.com/v.mp4?quality=1080p')).toBe(false);
    // Path segment, not a query key — this is a label for "the link expires", so a false positive
    // here would warn the user about a link that is in fact stable.
    expect(looksLikeSignedUrl('https://cdn.example.com/token/v.mp4')).toBe(false);
  });

  it('returns false rather than throwing on an unparsable URL', () => {
    expect(looksLikeSignedUrl('not-a-url?token=abc')).toBe(false);
    expect(looksLikeSignedUrl('')).toBe(false);
  });
});
