/**
 * docs/ROADMAP.md §8.1/§11.2 — the throughput/ETA estimates every job kind emits, extracted out of
 * utils/download-engine.ts (Phase 1) where the same two expressions were written out inline three
 * times (VOD write callback, live write callback, turbo chunk callback). Global SDK
 * (docs/design.md §9): pure arithmetic over numbers the caller already has.
 *
 * Estimates only, derived from THIS job's own observed throughput — HLS manifests give segment
 * duration, not byte size, so there is no way to know the real total upfront. The UI must render
 * `etaMs` as a "~" approximation (docs/shared/download-engine-protocol.ts's `DownloadEngineEvent`).
 */

/** Divides by at least one second so a job that has barely started can't report an absurd rate from
 * a few-millisecond denominator. */
export function throughputBytesPerSec(bytesDownloaded: number, elapsedMs: number): number {
  return bytesDownloaded / Math.max(elapsedMs / 1000, 1);
}

/** `undefined` until at least one unit is done — with nothing finished there is no observed rate to
 * extrapolate from, and reporting `0`/`Infinity` would render as a real (wrong) countdown. */
export function estimateEtaMs(done: number, total: number, elapsedMs: number): number | undefined {
  if (done <= 0) return undefined;
  return Math.round(((total - done) * elapsedMs) / done);
}
