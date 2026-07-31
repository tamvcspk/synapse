import type { ManifestSegment, SegmentKey } from '../../../../../shared/media-manifest-parser';
import { byteRangeToHeader } from '../../../../../shared/download/byte-ranges';
import { ivForSegment } from '../../../../../shared/download/hls-crypto';
import { MAX_FETCH_ATTEMPTS, backoffDelayMs, hasAttemptsLeft } from '../../../../../shared/download/retry';
import { debugLog } from './engine-events.offscreen';
import type { AuthFailureReporter, ReplayHeadersFor } from './background-relay.offscreen';
import type { JobControl } from './job-control.offscreen';

/**
 * docs/ROADMAP.md §8.3/§8.4/§10.1/§11.2 — one segment's worth of network + decryption, shared by
 * VOD's pooled workers and live capture's sequential loop. Split out of utils/download-engine.ts
 * (Phase 1). The PURE halves of what happens here (which IV, which backoff, which byte range,
 * whether a key is real DRM) live in `shared/download/` and are unit-tested there; what's left in
 * this file is exactly the I/O.
 */

// A run's segments overwhelmingly share one key (or a small handful across a key-rotating VOD
// playlist) — fetched once per key URI, not once per segment. Shared across jobs on purpose: a
// key URI is content-addressed, so caching it across concurrent jobs is always correct.
const aesKeyCache = new Map<string, Promise<CryptoKey>>();

async function loadAesKey(keyUri: string): Promise<CryptoKey> {
  let cached = aesKeyCache.get(keyUri);
  if (!cached) {
    cached = (async () => {
      const res = await fetch(keyUri);
      if (!res.ok) throw new Error(`Failed to fetch decryption key: HTTP ${res.status}`);
      return crypto.subtle.importKey('raw', await res.arrayBuffer(), 'AES-CBC', false, ['decrypt']);
    })();
    aesKeyCache.set(keyUri, cached);
  }
  return cached;
}

/** `crypto.subtle.decrypt`'s AES-CBC mode strips PKCS#7 padding itself — the exact padding HLS's
 * AES-128 uses, no extra handling needed here. */
async function decryptSegment(bytes: ArrayBuffer, key: SegmentKey, sequenceNumber: number): Promise<ArrayBuffer> {
  const cryptoKey = await loadAesKey(key.uri);
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivForSegment(key, sequenceNumber) }, cryptoKey, bytes);
}

export interface SegmentFetchDeps {
  jobId: string;
  control: JobControl;
  replayHeadersFor: ReplayHeadersFor;
  onAuthFailure: AuthFailureReporter;
  /** VOD-only (§7.4): a wholesale, by-index manifest re-fetch on 401/403/404/410. Live capture
   * (§10.1) has no equivalent — its own poll loop already refetches the manifest on its own cadence
   * — so live callers omit this and simply let the segment fail after exhausted retries. */
  tryRecoverExpiredUrl?: (() => Promise<boolean>) | undefined;
}

/**
 * docs/ROADMAP.md §8.3/§10.1 — one segment's fetch/retry/backoff/decrypt. Retries per
 * `MAX_FETCH_ATTEMPTS` (exponential backoff) before giving up; the CALLER decides what an
 * exhausted-retries failure means (VOD: abort the whole job, missing segment = broken video; live:
 * log and skip, one dropped segment shouldn't kill an hours-long capture). `getSegment()` is called
 * fresh on every attempt (not read once) so a VOD caller's `tryRecoverExpiredUrl` replacing the
 * whole segment list mid-retry is actually observed on the next attempt, not just on the very first.
 *
 * Bugfix (§8.1 follow-up): each attempt gets its own `AbortController`, registered on
 * `control.abortControllers` — CANCEL used to just let whichever segment was already in flight
 * finish naturally, but in practice that delay was long enough to be confusing: a fresh Download
 * click right after Cancel would silently no-op because the old job's entry hadn't settled out of
 * the job registry yet. `inFlight` tracking is the CALLER's job (per claimed-segment lifecycle, not
 * per attempt — see `noteFetchSettled`'s doc comment), not done here.
 */
export async function fetchAndDecryptSegment(getSegment: () => ManifestSegment, sequenceNumber: number, label: string, deps: SegmentFetchDeps): Promise<ArrayBuffer> {
  const { jobId, control, replayHeadersFor, onAuthFailure, tryRecoverExpiredUrl } = deps;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    control.abortControllers.add(controller);
    try {
      const segment = getSegment();
      debugLog(jobId, `${label} attempt ${attempt + 1}/${MAX_FETCH_ATTEMPTS} — fetching`, { url: segment.url });
      await replayHeadersFor(segment.url);
      const res = await fetch(segment.url, { signal: controller.signal });
      debugLog(jobId, `${label} attempt ${attempt + 1}/${MAX_FETCH_ATTEMPTS} — HTTP ${res.status}`);
      if (res.status === 401 || res.status === 403) {
        await onAuthFailure(segment.url, res.status);
        if (tryRecoverExpiredUrl && (await tryRecoverExpiredUrl())) continue; // retry now, doesn't consume a backoff wait
        throw new Error(`${label} failed: HTTP ${res.status} — the link expired and no manifest refresh was available, or this CDN's hotlink protection rejected the request.`);
      }
      if (res.status === 404 || res.status === 410) {
        if (tryRecoverExpiredUrl && (await tryRecoverExpiredUrl())) continue;
        throw new Error(`${label} failed: HTTP ${res.status} — that segment URL is no longer served${tryRecoverExpiredUrl ? ', and refreshing the manifest did not yield a working one' : ''}.`);
      }
      if (!res.ok) throw new Error(`${label} failed: HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      control.bytesDownloaded += bytes.byteLength;
      return segment.key ? await decryptSegment(bytes, segment.key, sequenceNumber) : bytes;
    } catch (err) {
      lastError = err;
      debugLog(jobId, `${label} attempt ${attempt + 1}/${MAX_FETCH_ATTEMPTS} — threw`, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      control.abortControllers.delete(controller);
    }
    // A CANCEL-triggered abort lands here as a caught error too — without this check the segment
    // would burn through its remaining retries against a server that never actually rejected it.
    if (control.cancelled) throw lastError instanceof Error ? lastError : new Error('Download cancelled.');
    if (hasAttemptsLeft(attempt)) await new Promise((r) => setTimeout(r, backoffDelayMs(attempt)));
  }
  debugLog(jobId, `${label} — exhausted all ${MAX_FETCH_ATTEMPTS} attempts, giving up`);
  throw lastError instanceof Error ? lastError : new Error(`${label} failed after ${MAX_FETCH_ATTEMPTS} attempts.`);
}

/** The `#EXT-X-MAP` init segment, written as the FIRST bytes of the output file — fetched inline,
 * bypassing the pool/writeChain (no worker has started yet at this point). Shared by VOD and live
 * capture (docs/ROADMAP.md §10.1). */
export async function fetchInitSegmentBytes(
  init: ManifestSegment,
  mediaSequence: number,
  replayHeadersFor: ReplayHeadersFor,
  onAuthFailure: AuthFailureReporter,
): Promise<ArrayBuffer> {
  await replayHeadersFor(init.url);
  const range = init.byteRange ? byteRangeToHeader(init.byteRange) : undefined;
  const res = await fetch(init.url, range ? { headers: { Range: range } } : {});
  if (res.status === 401 || res.status === 403) await onAuthFailure(init.url, res.status);
  if (!res.ok) throw new Error(`Initialization segment failed: HTTP ${res.status} (${init.url})`);
  const bytes = await res.arrayBuffer();
  return init.key ? await decryptSegment(bytes, init.key, mediaSequence) : bytes;
}
