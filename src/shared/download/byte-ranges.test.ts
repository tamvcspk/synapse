import { describe, expect, it } from 'vitest';
import { byteRangeToHeader, parseContentRangeTotal, planRangeChunks, rangeHeader } from './byte-ranges';

describe('byteRangeToHeader', () => {
  it('converts HLS <length>@<offset> into an inclusive HTTP range', () => {
    expect(byteRangeToHeader('1024@0')).toBe('bytes=0-1023');
    expect(byteRangeToHeader('100@500')).toBe('bytes=500-599');
  });

  it('defaults a missing offset to 0 (the HLS-spec meaning of a bare length)', () => {
    expect(byteRangeToHeader('2048')).toBe('bytes=0-2047');
  });

  it('tolerates surrounding whitespace from a raw tag body', () => {
    expect(byteRangeToHeader('  64@10  ')).toBe('bytes=10-73');
  });

  it('returns undefined for unparsable or empty ranges so the caller fetches the whole resource', () => {
    expect(byteRangeToHeader('')).toBeUndefined();
    expect(byteRangeToHeader('abc')).toBeUndefined();
    expect(byteRangeToHeader('0@0')).toBeUndefined();
    expect(byteRangeToHeader('-5@0')).toBeUndefined();
    expect(byteRangeToHeader('100@xyz')).toBeUndefined();
  });
});

describe('planRangeChunks', () => {
  it('covers exactly [0, total-1] with contiguous non-overlapping inclusive ranges', () => {
    const chunks = planRangeChunks(1000, 4);
    expect(chunks).toEqual([
      { index: 0, start: 0, end: 249 },
      { index: 1, start: 250, end: 499 },
      { index: 2, start: 500, end: 749 },
      { index: 3, start: 750, end: 999 },
    ]);
    expect(chunks[0]!.start).toBe(0);
    expect(chunks.at(-1)!.end).toBe(999);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.start).toBe(chunks[i - 1]!.end + 1);
  });

  it('clamps the tail chunk when the count does not divide the total evenly', () => {
    const chunks = planRangeChunks(10, 3);
    expect(chunks.at(-1)!.end).toBe(9);
    expect(chunks.reduce((sum, c) => sum + (c.end - c.start + 1), 0)).toBe(10);
  });

  it('emits FEWER chunks than requested rather than empty ones', () => {
    // 5 bytes over 6 connections: ceil(5/6)=1, so only 5 real chunks exist. The engine used to
    // express this as a `start > end` early-return inside the fetch loop, which meant a chunk that
    // never existed still occupied a slot in the pool's Promise.all.
    const chunks = planRangeChunks(5, 6);
    expect(chunks).toHaveLength(5);
    for (const chunk of chunks) expect(chunk.end).toBeGreaterThanOrEqual(chunk.start);
  });

  it('returns nothing for a non-positive or unknown total', () => {
    expect(planRangeChunks(0, 6)).toEqual([]);
    expect(planRangeChunks(-1, 6)).toEqual([]);
    expect(planRangeChunks(Number.NaN, 6)).toEqual([]);
    expect(planRangeChunks(1000, 0)).toEqual([]);
  });
});

describe('rangeHeader', () => {
  it('formats an inclusive byte range', () => {
    expect(rangeHeader(0, 0)).toBe('bytes=0-0');
    expect(rangeHeader(250, 499)).toBe('bytes=250-499');
  });
});

describe('parseContentRangeTotal', () => {
  it('reads the total out of a 206 Content-Range header', () => {
    expect(parseContentRangeTotal('bytes 0-0/12345')).toBe(12345);
  });

  it('rejects a missing header, an unknown total, or a non-positive one', () => {
    expect(parseContentRangeTotal(null)).toBeUndefined();
    expect(parseContentRangeTotal('bytes 0-0/*')).toBeUndefined();
    expect(parseContentRangeTotal('bytes 0-0/0')).toBeUndefined();
    expect(parseContentRangeTotal('nonsense')).toBeUndefined();
  });
});
