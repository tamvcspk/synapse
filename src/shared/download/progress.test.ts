import { describe, expect, it } from 'vitest';
import { estimateEtaMs, throughputBytesPerSec } from './progress';

describe('throughputBytesPerSec', () => {
  it('reports observed bytes per second', () => {
    expect(throughputBytesPerSec(10_000_000, 10_000)).toBe(1_000_000);
  });

  it('never divides by less than a second, so a just-started job cannot report an absurd rate', () => {
    expect(throughputBytesPerSec(5_000, 1)).toBe(5_000);
    expect(throughputBytesPerSec(5_000, 0)).toBe(5_000);
  });
});

describe('estimateEtaMs', () => {
  it('extrapolates the remaining time from the rate observed so far', () => {
    expect(estimateEtaMs(10, 100, 10_000)).toBe(90_000);
    expect(estimateEtaMs(99, 100, 99_000)).toBe(1_000);
  });

  it('is 0 once everything is done', () => {
    expect(estimateEtaMs(100, 100, 50_000)).toBe(0);
  });

  it('is undefined before anything finishes — there is no rate to extrapolate from yet', () => {
    expect(estimateEtaMs(0, 100, 3_000)).toBeUndefined();
  });
});
