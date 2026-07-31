/**
 * docs/ROADMAP.md §8.3/§11.2 — the download engine's retry POLICY, extracted out of
 * utils/download-engine.ts so it can be asserted on directly (Phase 1: "backoff policy → shared/").
 * Global SDK (docs/design.md §9): pure arithmetic, no `chrome.*`, no timers — the caller owns the
 * actual `setTimeout`, this only says how long to wait.
 *
 * The exact same policy backs all three job kinds (VOD segment pool, live capture loop, turbo range
 * chunks) — it was already literally duplicated between `fetchAndDecryptSegment` and `fetchChunk`
 * before this extraction, which is precisely how the two could have silently drifted apart.
 */

/** 1 initial try + 3 retries. Applies per segment/chunk, not per job. */
export const MAX_FETCH_ATTEMPTS = 4;

/**
 * Exponential backoff (500ms, 1s, 2s, …) capped at 5s so a long stall on a flaky CDN never turns
 * into a multi-minute silent wait. `attempt` is 0-based: the delay returned is the one to sleep
 * AFTER that attempt failed, before the next one.
 */
export function backoffDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 5000);
}

/** Whether another attempt is allowed after the 0-based `attempt` just failed — the "don't sleep
 * after the final attempt" guard, kept here so the callers can't disagree about the off-by-one. */
export function hasAttemptsLeft(attempt: number, maxAttempts: number = MAX_FETCH_ATTEMPTS): boolean {
  return attempt < maxAttempts - 1;
}
