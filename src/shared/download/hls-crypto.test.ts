import { describe, expect, it } from 'vitest';
import type { ManifestSegment, SegmentKey } from '../media-manifest-parser';
import { describeDrmKey, findRealDrmSegment, isRealDrm, ivForSegment } from './hls-crypto';

const aes = (over: Partial<SegmentKey> = {}): SegmentKey => ({ method: 'AES-128', uri: 'https://cdn.example.com/key.bin', ...over });

describe('isRealDrm', () => {
  it('lets plain AES-128 through — with no KEYFORMAT, or an explicit identity one', () => {
    expect(isRealDrm(aes())).toBe(false);
    expect(isRealDrm(aes({ keyFormat: 'identity' }))).toBe(false);
    expect(isRealDrm(aes({ keyFormat: 'IDENTITY' }))).toBe(false);
  });

  it('refuses SAMPLE-AES and any non-identity KEYFORMAT', () => {
    expect(isRealDrm(aes({ method: 'SAMPLE-AES' }))).toBe(true);
    expect(isRealDrm(aes({ keyFormat: 'com.widevine.alpha' }))).toBe(true);
    expect(isRealDrm(aes({ keyFormat: 'com.apple.streamingkeydelivery' }))).toBe(true);
    expect(isRealDrm(aes({ method: 'AES-256' }))).toBe(true);
  });
});

describe('findRealDrmSegment', () => {
  const segment = (key?: SegmentKey): ManifestSegment => (key ? { url: 'https://cdn.example.com/s.ts', key } : { url: 'https://cdn.example.com/s.ts' });

  it('finds DRM anywhere in the playlist, not just on the first segment (keys rotate)', () => {
    const drm = aes({ method: 'SAMPLE-AES' });
    expect(findRealDrmSegment([segment(), segment(aes()), segment(drm)])).toBe(drm);
  });

  it('returns undefined for an unencrypted or plain-AES-128 playlist', () => {
    expect(findRealDrmSegment([segment(), segment(aes())])).toBeUndefined();
    expect(findRealDrmSegment([])).toBeUndefined();
  });
});

describe('describeDrmKey', () => {
  it('names the method, and the KEYFORMAT only when there is one', () => {
    expect(describeDrmKey(aes({ method: 'SAMPLE-AES' }))).toBe('METHOD=SAMPLE-AES');
    expect(describeDrmKey(aes({ keyFormat: 'com.widevine.alpha' }))).toBe('METHOD=AES-128, KEYFORMAT=com.widevine.alpha');
  });
});

describe('ivForSegment', () => {
  it('derives the IV from the media sequence number, big-endian in the last 4 bytes', () => {
    expect(Array.from(ivForSegment(aes(), 1))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(Array.from(ivForSegment(aes(), 0x01020304))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]);
    expect(ivForSegment(aes(), 0)).toHaveLength(16);
  });

  it('prefers the key\'s own IV attribute, with or without the 0x prefix', () => {
    const expected = [0x0a, 0x0b, 0x0c, 0x0d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff];
    expect(Array.from(ivForSegment(aes({ iv: '0x0A0B0C0D0000000000000000000000FF' }), 7))).toEqual(expected);
    expect(Array.from(ivForSegment(aes({ iv: '0A0B0C0D0000000000000000000000FF' }), 7))).toEqual(expected);
  });

  it('zero-pads a short IV on the left and keeps the low 16 bytes of an over-long one', () => {
    expect(Array.from(ivForSegment(aes({ iv: '0xFF' }), 0))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff]);
    // 17 bytes of hex — the leading 0xAA must be dropped, not shift everything else along.
    expect(Array.from(ivForSegment(aes({ iv: '0xAA000000000000000000000000000000BB' }), 0))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xbb]);
  });

  it('wraps a sequence number past 2^32 the way >>> 0 does, without producing NaN bytes', () => {
    const iv = ivForSegment(aes(), 0x1_0000_0001);
    expect(Array.from(iv.slice(12))).toEqual([0, 0, 0, 1]);
  });
});
