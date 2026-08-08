/**
 * docs/ROADMAP.md Track A3 — the one pure decision `chrome.alarms`-driven GC sweeps (blob-store.ts's
 * review-blob sweep) reduce to: is this timestamp older than the retention window? Kept here,
 * pure and side-effect-free, so it's testable in `environment: 'node'` — the sweep itself touches
 * `indexedDB`/`chrome.storage` and is not (CLAUDE.md §4.2's Adapter carve-out).
 */
export function isExpired(createdAt: number, maxAgeMs: number, now: number = Date.now()): boolean {
  return now - createdAt > maxAgeMs;
}
