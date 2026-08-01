/**
 * The decisions behind the in-page UI compositor (docs/ROADMAP.md §11.4 Phase 3), separated from
 * the DOM work in `adapters/browser-extension/utils/ui-compositor.ts` so they can be tested at all:
 * vitest runs on `environment: 'node'` (docs/ROADMAP.md §11.1) and there is no DOM there.
 *
 * Global SDK Layer 1 (the `sdk-layers` skill): pure, no `chrome.*`, no DOM. That is not a
 * formality here — the compositor runs in TWO worlds that share no JS state (the extension's
 * ISOLATED content-script world for bundled Modules, the USER_SCRIPT world for uploaded scripts),
 * and the ordering rule below is only coherent if both worlds compute it identically from the same
 * inputs.
 */

/**
 * Hard caps on how much of the shared surface one owner can take, replacing "whoever renders first
 * wins" (docs/ROADMAP.md §11.4). Per *owner*, not global: a second script cannot be starved by a
 * first one that opened a lot of surfaces.
 */
export const SURFACE_QUOTA = {
  /** Persistent top-right icons. The plan said 1; it is 2 because a real consumer needs 2 —
   * `reader-mode-converter` shows Convert + Crawl (docs/ROADMAP.md §9.1). Raising it further would
   * turn the icon column into a toolbar, which is what the cap exists to prevent. */
  icon: 2,
  /** Toast cards visible at once. Older ones are evicted, never queued indefinitely — a toast that
   * shows up minutes late is worse than one that was dropped. */
  toast: 3,
  /** Badges anchored to page elements. Higher than the others because it scales with page content,
   * not with intent: one `<video>` on the page legitimately means one badge. */
  badge: 32,
} as const;

export type SurfaceKind = keyof typeof SURFACE_QUOTA;

/**
 * Where `ownerId`'s container belongs among the containers already in a zone.
 *
 * **This is the whole cross-world ordering guarantee.** The two worlds cannot share a registry, a
 * counter, or a lock, so order can never come from creation sequence (which is a race: whichever
 * world's script happens to run first). It comes from sorting the owner ids — a value both worlds
 * can read off the DOM — so each world independently computes the same position.
 *
 * `existing` must already be in sorted order (it is, by induction: every insertion goes through
 * here). Returns an index in `[0, existing.length]`.
 */
export function insertionIndexFor(existing: readonly string[], ownerId: string): number {
  let index = existing.length;
  for (let i = 0; i < existing.length; i++) {
    if (existing[i]! > ownerId) {
      index = i;
      break;
    }
  }
  return index;
}

/**
 * The key a surface is stored under. The caller only ever supplies `localId`; `ownerId` comes from
 * the transport (the shim's closure constant, or the bundled Module's build-time id) — the same
 * rule as `storage.rw`'s namespacing (docs/ROADMAP.md §11.3 constraint A), for the same reason.
 * Because every lookup goes through here, an id one script guesses about another is simply a
 * different key: there is no expressible way to address a neighbour's surface.
 */
export function surfaceKey(ownerId: string, localId: string): string {
  return `${ownerId}${KEY_SEPARATOR}${localId}`;
}

/**
 * `:` — the same separator and the same invariant as `script-storage.ts`, on purpose: an owner id
 * may not contain it (uploads are rejected at registration if they do; bundled ids are build-time
 * constants). That is what makes the split unambiguous *from the left*, so no `localId` a script
 * chooses can make its key parse as another owner's. Without an invariant on one side, any printable
 * separator is forgeable — `('a', 'b:c')` and `('a:b', 'c')` would produce the same string.
 *
 * NUL would be unforgeable without the invariant, but is unusable here for a concrete reason: these
 * keys go into a `data-key` attribute and are read back with `CSS.escape`, which maps U+0000 to
 * U+FFFD — the lookup would silently never match.
 */
export const KEY_SEPARATOR = ':';

/**
 * Whether `key` belongs to `ownerId`. The only supported way to ask: callers must never rebuild the
 * prefix by hand, because a separator mismatch fails *silently* — nothing matches, and surfaces leak
 * instead of being cleaned up.
 */
export function isKeyOf(ownerId: string, key: string): boolean {
  return key.startsWith(`${ownerId}${KEY_SEPARATOR}`);
}

/**
 * Token bucket limiting toast bursts per owner. Deliberately not a queue: a delayed toast describes
 * a moment that has passed. Over budget ⇒ the call is dropped and reported to the caller, never
 * silently swallowed (silent no-ops are the failure mode docs/ROADMAP.md §11.3 exists to remove).
 */
export interface ToastBudget {
  /** Fractional tokens available, capped at `BURST`. */
  tokens: number;
  /** `Date.now()` of the last admission decision. */
  updatedAt: number;
}

/** How many toasts an owner may fire back-to-back before the refill rate starts binding. */
export const TOAST_BURST = 3;
/** Sustained rate once the burst is spent. */
export const TOAST_REFILL_MS = 2000;

export function createToastBudget(now: number): ToastBudget {
  return { tokens: TOAST_BURST, updatedAt: now };
}

/** Pure: returns the decision and the next budget, never mutates. */
export function admitToast(budget: ToastBudget, now: number): { admitted: boolean; next: ToastBudget } {
  const refilled = Math.min(TOAST_BURST, budget.tokens + Math.max(0, now - budget.updatedAt) / TOAST_REFILL_MS);
  if (refilled < 1) return { admitted: false, next: { tokens: refilled, updatedAt: now } };
  return { admitted: true, next: { tokens: refilled - 1, updatedAt: now } };
}

/**
 * Whether a new surface of `kind` may be created, given how many the owner already has. Updating an
 * existing surface is not a creation and must not be routed through here — otherwise an owner that
 * refreshes its icon every second would eventually be told it is out of quota.
 */
export function withinQuota(kind: SurfaceKind, currentCount: number): boolean {
  return currentCount < SURFACE_QUOTA[kind];
}
