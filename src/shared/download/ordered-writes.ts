/**
 * docs/ROADMAP.md §8.3/§11.2 — the VOD segment pool's ordering bookkeeping, extracted out of
 * utils/download-engine.ts (Phase 1: "bookkeeping thứ tự pool → shared/"). Global SDK
 * (docs/design.md §9): pure — it holds no bytes' worth of meaning, does no I/O, and knows nothing
 * about OPFS. It answers exactly one question: given that segment `index` just finished
 * downloading, which segments are now releasable IN ORIGINAL ORDER?
 *
 * This is what makes `SEGMENT_POOL_SIZE` concurrent fetches safe: segments finish downloading in
 * whatever order the network hands them over, but the output file is one concatenated stream where
 * order IS the content. Buffering out-of-order arrivals until their predecessors land was previously
 * a `pendingWrites` Map plus a `nextToWrite` counter plus a `flushReady()` while-loop, all closures
 * over `runJob`'s mutable state — impossible to test without running a real download.
 */

export interface OrderedRelease<T> {
  index: number;
  value: T;
}

export interface OrderedBuffer<T> {
  /**
   * Records `value` as segment `index`'s payload and returns everything that is now releasable, in
   * ascending index order — empty when `index` arrived ahead of a still-missing predecessor, and
   * several entries at once when `index` was the gap everything behind it was waiting on.
   */
  add(index: number, value: T): OrderedRelease<T>[];
  /** The index the buffer is currently waiting on — nothing at or after it has been released yet. */
  nextIndex(): number;
  /** How many arrivals are buffered waiting for a predecessor. The pool bounds this implicitly (at
   * most one in-flight segment per worker can be waiting), which is why buffering whole segments in
   * memory is acceptable here but NOT for the turbo downloader's handful of huge chunks. */
  pendingCount(): number;
}

export function createOrderedBuffer<T>(startIndex = 0): OrderedBuffer<T> {
  const pending = new Map<number, T>();
  let nextIndex = startIndex;
  return {
    add(index, value) {
      // An index at or before the cursor was already released — re-adding it would rewrite bytes
      // that are already on disk, so it is dropped rather than trusted.
      if (index < nextIndex) return [];
      pending.set(index, value);
      const released: OrderedRelease<T>[] = [];
      while (pending.has(nextIndex)) {
        released.push({ index: nextIndex, value: pending.get(nextIndex)! });
        pending.delete(nextIndex);
        nextIndex++;
      }
      return released;
    },
    nextIndex() {
      return nextIndex;
    },
    pendingCount() {
      return pending.size;
    },
  };
}
