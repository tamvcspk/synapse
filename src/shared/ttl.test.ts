import { describe, expect, it } from 'vitest';
import { isExpired } from './ttl';

describe('isExpired', () => {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  it('is false exactly at the boundary and just under it', () => {
    const now = 1_000_000;
    expect(isExpired(now - ONE_DAY_MS, ONE_DAY_MS, now)).toBe(false);
    expect(isExpired(now - (ONE_DAY_MS - 1), ONE_DAY_MS, now)).toBe(false);
  });

  it('is true once older than maxAgeMs', () => {
    const now = 1_000_000;
    expect(isExpired(now - (ONE_DAY_MS + 1), ONE_DAY_MS, now)).toBe(true);
  });

  it('defaults `now` to Date.now() when omitted', () => {
    expect(isExpired(Date.now() - 1, ONE_DAY_MS)).toBe(false);
    expect(isExpired(0, ONE_DAY_MS)).toBe(true);
  });
});
