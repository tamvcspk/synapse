import { describe, expect, it } from 'vitest';
import { MAX_FETCH_ATTEMPTS, backoffDelayMs, hasAttemptsLeft } from './retry';

describe('backoffDelayMs', () => {
  it('doubles from 500ms per failed attempt', () => {
    expect([0, 1, 2, 3].map(backoffDelayMs)).toEqual([500, 1000, 2000, 4000]);
  });

  it('caps at 5s so a flaky CDN never turns into a multi-minute silent wait', () => {
    expect(backoffDelayMs(4)).toBe(5000);
    expect(backoffDelayMs(20)).toBe(5000);
  });
});

describe('hasAttemptsLeft', () => {
  it('allows a retry after every attempt but the last', () => {
    // MAX_FETCH_ATTEMPTS is "1 initial try + 3 retries", so attempts 0..2 may sleep-and-retry and
    // attempt 3 must give up — the off-by-one this function exists to keep in one place.
    expect([0, 1, 2, 3].map((a) => hasAttemptsLeft(a))).toEqual([true, true, true, false]);
    expect(MAX_FETCH_ATTEMPTS).toBe(4);
  });

  it('honours a caller-supplied attempt budget', () => {
    expect(hasAttemptsLeft(0, 1)).toBe(false);
    expect(hasAttemptsLeft(0, 2)).toBe(true);
  });
});
