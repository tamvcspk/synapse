import type { ManifestSegment, SegmentKey } from '../media-manifest-parser';

/**
 * docs/ROADMAP.md §8.4/§11.2 — the two PURE decisions behind HLS segment decryption, extracted out
 * of utils/download-engine.ts (Phase 1: "`ivForSegment` → shared/"). Global SDK (docs/design.md §9):
 * no `crypto.subtle`, no `fetch` — key fetching and the actual AES-CBC call stay in the engine,
 * because they are I/O. What lives here is what a test can actually pin down: which segments are
 * refused outright, and exactly which 16 bytes become the IV.
 */

/**
 * docs/ROADMAP.md §8.4 — plain HLS segment encryption (`METHOD=AES-128`, key served in the clear via
 * the manifest's own `URI=`) is decrypted so these streams download like any other stream; real DRM
 * (`SAMPLE-AES`, or any `KEYFORMAT` other than `identity` — Widevine/PlayReady/FairPlay) is refused
 * outright, never attempted. Hard security boundary, not a UI nicety: feeding a real-DRM segment
 * into ffmpeg.wasm's `-c copy` doesn't fail loudly, it produces a silently-corrupt file.
 */
export function isRealDrm(key: SegmentKey): boolean {
  return key.method !== 'AES-128' || (key.keyFormat !== undefined && key.keyFormat.toLowerCase() !== 'identity');
}

/** The first segment carrying real DRM, if any — the shape every guard in the engine wants (start,
 * resume, and mid-live-capture all need the offending key to name it in their error message). */
export function findRealDrmSegment(segments: readonly ManifestSegment[]): SegmentKey | undefined {
  return segments.find((s) => s.key && isRealDrm(s.key))?.key;
}

/** The human-readable half of the DRM refusal, shared by all three guard sites so they can't word
 * the same refusal three different ways. */
export function describeDrmKey(key: SegmentKey): string {
  return `METHOD=${key.method}${key.keyFormat ? `, KEYFORMAT=${key.keyFormat}` : ''}`;
}

/** IV = the key's own `IV=0x...` attribute when present; otherwise the HLS-spec default — the
 * segment's media sequence number, big-endian, zero-padded to 16 bytes. */
export function ivForSegment(key: SegmentKey, sequenceNumber: number): Uint8Array<ArrayBuffer> {
  if (key.iv) {
    const hex = key.iv.replace(/^0x/i, '').padStart(32, '0').slice(-32);
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  const bytes = new Uint8Array(16);
  new DataView(bytes.buffer).setUint32(12, sequenceNumber >>> 0, false);
  return bytes;
}
