import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
// `?url` (plain Vite feature, not crx's `?script&iife`) — fetched by the ffmpeg.wasm worker itself
// only once `ffmpeg.load()` actually runs, not eagerly at module load.
import ffmpegCoreUrl from '@ffmpeg/core?url';
import ffmpegWasmUrl from '@ffmpeg/core/wasm?url';
import { parseM3u8, type ManifestSegment, type ParsedManifest, type SegmentKey } from '../../../shared/media-manifest-parser';
import { slugify } from '../../../shared/slugify';
import type { DownloadEngineEvent, DownloadEngineRelayedCommand, DownloadEnginePhase, DownloadJobCheckpoint } from '../../../shared/download-engine-protocol';
import { createOpfsRun, removeOpfsRun, tryResumeOpfsRun, type OpfsRun } from './opfs-store';
import type { DescribeHeaderReplayResult } from './header-replay-rules';

/**
 * docs/ROADMAP.md §8.1 — the HLS download/remux engine, ported out of the old `ui/merge/main.ts`
 * Tab into headless, message-driven code that runs inside the singleton Offscreen Document
 * (ui/offscreen/main.ts just wires `handleEngineCommand` to incoming messages). Every function here
 * used to take DOM elements (`status`, `startBtn`, `actions`) to report progress into — replaced by
 * `emit()`, which broadcasts a `DownloadEngineEvent` that Side Panel/Dashboard listen for directly.
 *
 * Multi-job by necessity, not by choice: MV3 allows exactly ONE offscreen document per extension,
 * so this file is a shared queue (`jobs: Map<jobId, JobControl>`) rather than one instance per
 * download. `jobId` is always `DetectedMedia.id` (docs/ROADMAP.md §7.6's existing convention).
 *
 * Ported WITHOUT the old page's tab-scoping dance: `syncHeaderReplayRule`'s `tabIds` param already
 * defaults to `[chrome.tabs.TAB_ID_NONE]` — the same scope the background service worker's own
 * fetches use — and an offscreen document's fetches are not tied to any tab either, so the old
 * `selfTabIds`/`sameTabIds` machinery (which existed only because a Tab's own fetches carry a real
 * tabId) is dropped entirely, not ported.
 *
 * docs/ROADMAP.md §8.11 — bugfix discovered via a real download: Offscreen Documents can use ONLY
 * `chrome.runtime`, confirmed against Chrome's own documentation after `chrome.downloads.download()`
 * threw "Cannot read properties of undefined" from inside this file. `chrome.storage` and
 * `chrome.declarativeNetRequest` are unavailable here too — silently, no error at import time, only
 * when the call actually runs — which meant header replay (§7.1) had been quietly broken for every
 * download since the engine moved into the Offscreen Document (its `chrome.storage` lookup was
 * wrapped in a `.catch()`, so it degraded to "no headers captured" instead of crashing).
 * See `requestFromBackground`'s doc comment below — every one of these now round-trips
 * through `background/index.ts`, the one context with full chrome.* access.
 */

const SEGMENT_POOL_SIZE = 5;
const REMUX_SIZE_CAP_BYTES = 2 * 1024 * 1024 * 1024;

interface JobControl {
  cancelled: boolean;
  pausedPromise: Promise<void> | null;
  resolvePause: (() => void) | null;
  segmentsDone: number;
  segmentsTotal: number;
  bytesDownloaded: number;
  startedAt: number;
  /** Registered by BOTH job kinds now (HLS's `fetchSegment`, turbo's `fetchChunk`) — one entry per
   * currently-in-flight `fetch()`, aborted outright by `cancelJob` so CANCEL takes effect
   * immediately instead of waiting for whatever's already downloading to finish naturally. */
  abortControllers: Set<AbortController>;
  /** How many segment/chunk fetch ATTEMPTS (the literal `fetch()` call, not the whole retry loop
   * around it) are happening right now — used only to know when a requested PAUSE has actually taken
   * effect. See `pauseJob`/`noteFetchSettled`. */
  inFlight: number;
  /** Which phase a RESUME should re-emit — the UI renders `'segments'`/`'chunks'` identically, this
   * just keeps emitted events semantically accurate for whichever job kind this is. */
  kind: 'segments' | 'chunks';
  /** docs/ROADMAP.md §10.1 — set once at job creation. `pauseJob`/`resumeJob`/`noteFetchSettled` are
   * generic (not live-aware) and emit on behalf of any job kind, so this is threaded through their
   * events the same way `kind` already is — otherwise a pause/resume event for a live job would emit
   * with no `live` flag at all, which the Side Panel would read as "live-ness unknown" and silently
   * revert its live-specific rendering on every Pause click. */
  live: boolean;
  /** docs/ROADMAP.md §10.1 — set by the `STOP_LIVE` command or by the live poll loop itself seeing
   * `#EXT-X-ENDLIST`. Only ever read by `runLiveJob`; VOD/turbo jobs never set it. */
  liveStopRequested?: boolean;
}

const jobs = new Map<string, JobControl>();

/** Debug-only state tracing, added while chasing a real report of a job hanging on "Starting…" with
 * nothing in the offscreen document's own console to explain why (chrome://extensions' "Inspect
 * views" → offscreen.html) — every command received, every event emitted, and every `inFlight`
 * transition now shows up there with a `[download-engine]` prefix, so a future repro can be read
 * straight off the console instead of guessed at from code. Deliberately left in (not stripped for
 * "production") — this extension has no telemetry/analytics of its own, and this is the ONLY place
 * that would ever surface exactly what the engine did for a given `jobId`. */
function debugLog(jobId: string, message: string, extra?: Record<string, unknown>): void {
  console.log(`[download-engine] ${jobId}: ${message}`, extra ?? '');
}

function emit(jobId: string, phase: DownloadEnginePhase, extra?: Partial<DownloadEngineEvent>): void {
  const event: DownloadEngineEvent = { type: 'synapse:download-engine-event', jobId, phase, ...extra };
  debugLog(jobId, `emit '${phase}'`, extra);
  chrome.runtime.sendMessage(event).catch((err: unknown) => {
    // Side Panel not open, or closed mid-download — expected and harmless (docs/ROADMAP.md §7.6's
    // existing "no persistence" posture), but worth a trace line since it explains a UI that looks
    // stuck: the event was sent, just never delivered anywhere.
    debugLog(jobId, `emit '${phase}' had no listener (sendMessage rejected)`, { error: String(err) });
  });
}

export function handleEngineCommand(cmd: DownloadEngineRelayedCommand): void {
  debugLog(cmd.jobId, `received command '${cmd.op}'`, { url: cmd.url });
  switch (cmd.op) {
    case 'START':
      if (cmd.url) void startJob(cmd.jobId, cmd.url, cmd.resolutionLabel);
      break;
    case 'START_TURBO':
      if (cmd.url) void startTurboJob(cmd.jobId, cmd.url);
      break;
    case 'PAUSE':
      pauseJob(cmd.jobId);
      break;
    case 'RESUME':
      resumeJob(cmd.jobId);
      break;
    case 'CANCEL':
      cancelJob(cmd.jobId);
      break;
    case 'RESUME_CHECKPOINT':
      if (cmd.checkpoint) void resumeJobFromCheckpoint(cmd.checkpoint);
      break;
    case 'STOP_LIVE':
      stopLiveJob(cmd.jobId);
      break;
  }
}

/** docs/ROADMAP.md §10.1 — a GRACEFUL finish for a live capture: drain whatever's already queued,
 * then fall through to the same finish path as reaching `#EXT-X-ENDLIST` naturally (remux once,
 * produce output) — as opposed to `CANCEL`, which discards. No-op if `jobId` isn't a live job (or
 * isn't running at all): `runLiveJob` is the only reader of this flag. */
function stopLiveJob(jobId: string): void {
  const control = jobs.get(jobId);
  if (!control?.live) {
    debugLog(jobId, 'STOP_LIVE ignored — no such job, or not a live job');
    return;
  }
  debugLog(jobId, 'STOP_LIVE requested');
  control.liveStopRequested = true;
}

/**
 * Bugfix: PAUSE used to emit `'paused'` immediately, but it only stops NEW segment/chunk claims —
 * up to one fetch per worker/chunk was typically still genuinely in flight and would still complete
 * (and still get written) a moment later, re-emitting `'segments'`/`'chunks'` events right after.
 * From the UI, that looked like the Pause button flipping to Resume for an instant and then
 * flipping right back, while segments kept visibly arriving after "Paused" was already on screen.
 * `'pausing'` is the honest intermediate state — `noteFetchSettled` promotes it to `'paused'` once
 * `inFlight` actually reaches zero. If nothing is in flight yet (PAUSE clicked before any fetch
 * started), it's genuinely paused right away.
 */
function pauseJob(jobId: string): void {
  const control = jobs.get(jobId);
  if (!control) {
    debugLog(jobId, 'PAUSE ignored — no such job (already finished/settled?)');
    return;
  }
  if (control.pausedPromise) {
    debugLog(jobId, 'PAUSE ignored — already paused/pausing');
    return;
  }
  control.pausedPromise = new Promise((resolve) => {
    control.resolvePause = resolve;
  });
  debugLog(jobId, `PAUSE requested, inFlight=${control.inFlight}`);
  emit(jobId, control.inFlight > 0 ? 'pausing' : 'paused', { segmentsDone: control.segmentsDone, segmentsTotal: control.segmentsTotal, live: control.live });
}

function resumeJob(jobId: string): void {
  const control = jobs.get(jobId);
  if (!control?.pausedPromise) {
    debugLog(jobId, 'RESUME ignored — not currently paused/pausing');
    return;
  }
  control.resolvePause?.();
  control.pausedPromise = null;
  control.resolvePause = null;
  debugLog(jobId, `RESUME — re-emitting '${control.kind}'`);
  emit(jobId, control.kind, { segmentsDone: control.segmentsDone, segmentsTotal: control.segmentsTotal, live: control.live });
}

/** Decrements `inFlight` once a segment/chunk fetch ATTEMPT settles (success or failure) and
 * promotes a pending PAUSE from `'pausing'` to `'paused'` the moment every such attempt has actually
 * stopped — called from both HLS's `fetchSegment` and turbo's `fetchChunk`. */
function noteFetchSettled(jobId: string, control: JobControl): void {
  control.inFlight = Math.max(0, control.inFlight - 1);
  debugLog(jobId, `fetch attempt settled, inFlight now ${control.inFlight}`);
  if (control.pausedPromise && control.inFlight === 0) {
    debugLog(jobId, "inFlight reached 0 while pausing — promoting to 'paused'");
    emit(jobId, 'paused', { segmentsDone: control.segmentsDone, segmentsTotal: control.segmentsTotal, live: control.live });
  }
}

/** Also wakes a paused worker loop (resolves `pausedPromise`) so it observes `cancelled` on its next
 * check and exits, instead of hanging forever waiting for a RESUME that will never come. Aborts every
 * in-flight fetch (both job kinds now register in `abortControllers`) so CANCEL takes effect
 * immediately instead of waiting for whatever's already downloading to finish naturally — the old
 * "let HLS segments finish naturally" behavior was the direct cause of a confusing overlap window
 * where a fresh Download click right after Cancel would silently no-op against the still-settling
 * previous job. */
function cancelJob(jobId: string): void {
  const control = jobs.get(jobId);
  if (!control) {
    debugLog(jobId, 'CANCEL ignored — no such job (already finished/settled?)');
    return;
  }
  debugLog(jobId, `CANCEL requested — aborting ${control.abortControllers.size} in-flight fetch(es)`);
  control.cancelled = true;
  control.resolvePause?.();
  control.pausedPromise = null;
  control.resolvePause = null;
  for (const controller of control.abortControllers) controller.abort();
}

/** docs/ROADMAP.md §8.4 — plain HLS segment encryption (`METHOD=AES-128`, key served in the clear
 * via the manifest's own `URI=`) is decrypted so these streams download like any other stream; real
 * DRM (`SAMPLE-AES`, or any `KEYFORMAT` other than `identity` — Widevine/PlayReady/FairPlay) is
 * refused outright, never attempted. Hard security boundary, not a UI nicety. */
function isRealDrm(key: SegmentKey): boolean {
  return key.method !== 'AES-128' || (key.keyFormat !== undefined && key.keyFormat.toLowerCase() !== 'identity');
}

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

/** IV = the key's own `IV=0x...` attribute when present; otherwise the HLS-spec default — the
 * segment's media sequence number, big-endian, zero-padded to 16 bytes. */
function ivForSegment(key: SegmentKey, sequenceNumber: number): Uint8Array<ArrayBuffer> {
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

/** HLS writes a byte range as `<length>[@<offset>]`; HTTP wants `bytes=<first>-<last>`. Returns
 * `undefined` for unparsable input, which the caller treats as "fetch the whole resource". */
function byteRangeToHeader(byteRange: string): string | undefined {
  const [lengthText, offsetText] = byteRange.trim().split('@');
  const length = Number(lengthText);
  const offset = offsetText === undefined ? 0 : Number(offsetText);
  if (!Number.isFinite(length) || !Number.isFinite(offset) || length <= 0) return undefined;
  return `bytes=${offset}-${offset + length - 1}`;
}

/** `crypto.subtle.decrypt`'s AES-CBC mode strips PKCS#7 padding itself — the exact padding HLS's
 * AES-128 uses, no extra handling needed here. */
async function decryptSegment(bytes: ArrayBuffer, key: SegmentKey, sequenceNumber: number): Promise<ArrayBuffer> {
  const cryptoKey = await loadAesKey(key.uri);
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivForSegment(key, sequenceNumber) }, cryptoKey, bytes);
}

function fileNameFromUrl(url: string): string {
  try {
    const { pathname } = new URL(url);
    return pathname.slice(pathname.lastIndexOf('/') + 1).replace(/\.m3u8$/, '');
  } catch {
    return '';
  }
}

/**
 * docs/ROADMAP.md §8.11 — offscreen documents can use ONLY `chrome.runtime` (confirmed against
 * Chrome's own docs after `chrome.downloads.download()` threw "Cannot read properties of undefined"
 * from inside this file during a real download) — `chrome.storage`, `chrome.declarativeNetRequest`,
 * and `chrome.downloads` are all unavailable here despite no error at IMPORT time (the failure only
 * surfaces the first time the call actually runs). `findReplayHeaders`/`syncHeaderReplayRule`'s
 * `chrome.storage`/`chrome.declarativeNetRequest` calls used to be made directly from this file —
 * silently broken (swallowed by `.catch(() => undefined)`) for every download since the engine moved
 * into the Offscreen Document, never crashing, just quietly never replaying captured headers. Every
 * one of these now goes through `background/index.ts`, which has full `chrome.*` access.
 */
async function requestFromBackground<T>(message: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

/** docs/ROADMAP.md §8.12 — same relay pattern as `findReplayHeaders` above: this document has no
 * `chrome.storage` of its own, so persisting/clearing a checkpoint round-trips through background
 * (utils/download-job-checkpoints.ts). Both are fire-and-forget from the CALLER's point of view — a
 * dropped checkpoint write just means resume falls back a little further than it could have; it
 * never corrupts anything, since a resume always re-validates against the OPFS file's real size
 * before trusting one (see opfs-store.ts's `tryResumeOpfsRun`). Bugfix-in-waiting (§8.8's lesson
 * applied preemptively): a bare `.catch(() => {})` here would silently swallow a broken relay
 * exactly the way §8.11 found header replay had been broken for weeks — logged instead, even though
 * a failure here is non-fatal to THIS download. */
async function persistCheckpoint(checkpoint: DownloadJobCheckpoint): Promise<void> {
  await requestFromBackground<{ ok?: boolean }>({ type: 'synapse:save-download-checkpoint', checkpoint }).catch((err: unknown) => {
    debugLog(checkpoint.jobId, 'checkpoint save failed to reach background (resume will fall back further than it could have)', { error: err instanceof Error ? err.message : String(err) });
  });
}

async function clearCheckpoint(jobId: string): Promise<void> {
  await requestFromBackground<{ ok?: boolean }>({ type: 'synapse:remove-download-checkpoint', jobId }).catch((err: unknown) => {
    debugLog(jobId, 'checkpoint clear failed to reach background (a stale checkpoint may linger until the next Offscreen Document sweep)', { error: err instanceof Error ? err.message : String(err) });
  });
}

/** docs/ROADMAP.md #7.1 — the entry that had this URL (as its own `url`, or as one of its
 * `variants`) is the one whose captured headers apply here. Looked up in background (see this
 * file's `requestFromBackground` doc comment) since it needs `chrome.storage`. */
async function findReplayHeaders(url: string): Promise<Record<string, string> | undefined> {
  const response = await requestFromBackground<{ headers?: Record<string, string> }>({ type: 'synapse:query-replay-headers', url });
  return response?.headers;
}

/** docs/ROADMAP.md #7.1/§8.2 — shared by both job kinds (HLS's `startJob`, turbo's `startTurboJob`):
 * looks up whichever `DetectedMedia` entry captured headers for `referenceUrl`, then returns a
 * `replayHeadersFor(url)` closure that no-ops when there's nothing captured, and dedupes by host
 * (a job's URLs overwhelmingly share one host, so this avoids hundreds of redundant relay
 * round-trips to background for the same `chrome.declarativeNetRequest` rule). */
async function createReplayHeaderApplier(referenceUrl: string): Promise<(url: string) => Promise<void>> {
  const replayHeaders = await findReplayHeaders(referenceUrl).catch(() => undefined);
  const hostsSynced = new Set<string>();
  return async (url: string) => {
    if (!replayHeaders) return;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }
    if (hostsSynced.has(host)) return;
    hostsSynced.add(host);
    await requestFromBackground({ type: 'synapse:sync-header-replay-rule', host, headers: replayHeaders }).catch(() => {});
  };
}

/**
 * docs/ROADMAP.md #7.4 — a segment 401/403/404/410 mid-run usually means its signed URL expired or
 * the sliding window moved on, not that the video vanished: refetching the SAME manifest almost
 * always reissues the whole segment list with fresh signatures. The caller replaces its working
 * `segments` array WHOLESALE, by INDEX — safe under the concurrent pool because already-fetched-
 * and-written indices are never re-read, only not-yet-fetched ones observe the replacement. Only
 * attempted once per job and only when confirmed VOD (`!isLive`) — a live playlist's window slides,
 * so index i doesn't name the same segment in a re-fetch.
 */
async function tryRefreshSegmentsFromIndex(
  manifestUrl: string,
  fromIndex: number,
  replayHeadersFor: (url: string) => Promise<void>,
): Promise<ManifestSegment[] | undefined> {
  try {
    await replayHeadersFor(manifestUrl);
    const text = await (await fetch(manifestUrl)).text();
    const reparsed = parseM3u8(text, manifestUrl);
    if (reparsed.kind !== 'media' || reparsed.isLive || reparsed.segments.length <= fromIndex) return undefined;
    return reparsed.segments;
  } catch {
    return undefined;
  }
}

interface SegmentFetchDeps {
  jobId: string;
  control: JobControl;
  replayHeadersFor: (url: string) => Promise<void>;
  onAuthFailure: (url: string, statusCode: number) => Promise<void>;
  /** VOD-only (§7.4): a wholesale, by-index manifest re-fetch on 401/403/404/410. Live capture
   * (§10.1) has no equivalent — its own poll loop already refetches the manifest on its own cadence
   * — so live callers omit this and simply let the segment fail after exhausted retries. */
  tryRecoverExpiredUrl?: (() => Promise<boolean>) | undefined;
}

/**
 * docs/ROADMAP.md §8.3/§10.1 — one segment's fetch/retry/backoff/decrypt, shared by VOD's pooled
 * `worker()` and live capture's sequential loop. Retries up to 3 times (exponential backoff) before
 * giving up; the CALLER decides what an exhausted-retries failure means (VOD: abort the whole job,
 * missing segment = broken video; live: log and skip, one dropped segment shouldn't kill an
 * hours-long capture). `getSegment()` is called fresh on every attempt (not read once) so a VOD
 * caller's `tryRecoverExpiredUrl` replacing the whole segment list mid-retry is actually observed on
 * the next attempt, not just on the very first one.
 *
 * Bugfix (§8.1 follow-up): each attempt gets its own `AbortController`, registered on
 * `control.abortControllers` — CANCEL used to just let whichever segment was already in flight
 * finish naturally, but in practice that delay was long enough to be confusing: a fresh Download
 * click right after Cancel would silently no-op because the old job's entry hadn't settled out of
 * `jobs`/`activeDownloads` yet. `inFlight` tracking is the CALLER's job (per claimed-segment
 * lifecycle, not per attempt — see `noteFetchSettled`'s doc comment), not done here.
 */
async function fetchAndDecryptSegment(getSegment: () => ManifestSegment, sequenceNumber: number, label: string, deps: SegmentFetchDeps): Promise<ArrayBuffer> {
  const { jobId, control, replayHeadersFor, onAuthFailure, tryRecoverExpiredUrl } = deps;
  const MAX_ATTEMPTS = 4; // 1 initial try + 3 retries
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    control.abortControllers.add(controller);
    try {
      const segment = getSegment();
      debugLog(jobId, `${label} attempt ${attempt + 1}/${MAX_ATTEMPTS} — fetching`, { url: segment.url });
      await replayHeadersFor(segment.url);
      const res = await fetch(segment.url, { signal: controller.signal });
      debugLog(jobId, `${label} attempt ${attempt + 1}/${MAX_ATTEMPTS} — HTTP ${res.status}`);
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
      debugLog(jobId, `${label} attempt ${attempt + 1}/${MAX_ATTEMPTS} — threw`, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      control.abortControllers.delete(controller);
    }
    // A CANCEL-triggered abort lands here as a caught error too — without this check the segment
    // would burn through its remaining retries against a server that never actually rejected it.
    if (control.cancelled) throw lastError instanceof Error ? lastError : new Error('Download cancelled.');
    if (attempt < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 5000)));
  }
  debugLog(jobId, `${label} — exhausted all ${MAX_ATTEMPTS} attempts, giving up`);
  throw lastError instanceof Error ? lastError : new Error(`${label} failed after ${MAX_ATTEMPTS} attempts.`);
}

/** The `#EXT-X-MAP` init segment, written as the FIRST bytes of the output file — fetched inline,
 * bypassing the pool/writeChain (no worker has started yet at this point). Shared by VOD's `runJob`
 * and live capture's `runLiveJob` (docs/ROADMAP.md §10.1). */
async function fetchInitSegmentBytes(
  init: ManifestSegment,
  mediaSequence: number,
  replayHeadersFor: (url: string) => Promise<void>,
  onAuthFailure: (url: string, statusCode: number) => Promise<void>,
): Promise<ArrayBuffer> {
  await replayHeadersFor(init.url);
  const range = init.byteRange ? byteRangeToHeader(init.byteRange) : undefined;
  const res = await fetch(init.url, range ? { headers: { Range: range } } : {});
  if (res.status === 401 || res.status === 403) await onAuthFailure(init.url, res.status);
  if (!res.ok) throw new Error(`Initialization segment failed: HTTP ${res.status} (${init.url})`);
  const bytes = await res.arrayBuffer();
  return init.key ? await decryptSegment(bytes, init.key, mediaSequence) : bytes;
}

async function startJob(jobId: string, manifestUrl: string, resolutionLabel?: string): Promise<void> {
  if (jobs.has(jobId)) return; // already running — Side Panel already guards this, enforced again
  // here since Dashboard's smart-download can trigger the same id independently.
  const control: JobControl = {
    cancelled: false,
    pausedPromise: null,
    resolvePause: null,
    segmentsDone: 0,
    segmentsTotal: 0,
    bytesDownloaded: 0,
    startedAt: Date.now(),
    abortControllers: new Set(),
    inFlight: 0,
    kind: 'segments',
    live: false, // flipped to manifest.isLive once the manifest is fetched, below
  };
  jobs.set(jobId, control);
  debugLog(jobId, `START — manifestUrl=${manifestUrl}`);
  try {
    const replayHeadersFor = await createReplayHeaderApplier(manifestUrl);

    let manifest: ParsedManifest;
    try {
      await replayHeadersFor(manifestUrl);
      const text = await (await fetch(manifestUrl)).text();
      manifest = parseM3u8(text, manifestUrl);
    } catch (err) {
      // Bugfix: this used to swallow `err` completely — a real CORS/network failure fetching the
      // manifest reported a static, unrelated-sounding "Could not fetch" message with NOTHING
      // logged anywhere to explain what actually went wrong underneath.
      console.error(`Synapse download engine: job ${jobId} failed to fetch/parse the manifest`, err);
      emit(jobId, 'error', { message: `Could not fetch this URL: ${manifestUrl} (${err instanceof Error ? err.message : String(err)})` });
      return;
    }

    debugLog(jobId, `manifest fetched — kind='${manifest.kind}'`, manifest.kind === 'media' ? { segments: manifest.segments.length, isLive: manifest.isLive } : undefined);

    if (manifest.kind === 'unknown') {
      emit(jobId, 'error', { message: "This URL doesn't look like an HLS manifest (no #EXTINF or #EXT-X-STREAM-INF found in it)." });
      return;
    }
    if (manifest.kind === 'master') {
      emit(jobId, 'error', {
        message:
          "This is a master playlist listing multiple resolutions, not a single downloadable stream. Pick a specific resolution from this video's list in the Side Panel or Dashboard instead.",
      });
      return;
    }

    // Mandatory guard, not optional (docs/ROADMAP.md #5.3/#8.4) — feeding a real-DRM segment into
    // ffmpeg.wasm's `-c copy` doesn't fail loudly, it produces a silently-corrupt file. Plain
    // AES-128 (identity KEYFORMAT) is NOT blocked here — runJob decrypts it transparently.
    const drmSegment = manifest.segments.find((s) => s.key && isRealDrm(s.key));
    if (drmSegment?.key) {
      const key = drmSegment.key;
      emit(jobId, 'error', {
        message: `This stream is DRM-protected (METHOD=${key.method}${key.keyFormat ? `, KEYFORMAT=${key.keyFormat}` : ''}). Synapse cannot and will not attempt to download or remux DRM-protected content.`,
      });
      return;
    }

    control.live = manifest.isLive;
    if (manifest.isLive) {
      await runLiveJob(jobId, control, manifest, manifestUrl, replayHeadersFor);
    } else {
      await runJob(jobId, control, manifest, manifestUrl, replayHeadersFor, { resolutionLabel });
    }
  } catch (err) {
    // Bugfix: nothing in this file used to `console.error` a genuine job failure — only the 401/403
    // diagnostic (`logSegmentAuthDiagnostics`) and a remux fallback ever logged anything, so a plain
    // network/HTTP failure reached the Side Panel's "Failed: ..." text with NOTHING in the offscreen
    // document's own console (chrome://extensions' "Inspect views") to explain why. Log the full
    // error object (not just its message) here so it's actually diagnosable next time.
    console.error(`Synapse download engine: job ${jobId} failed`, err);
    emit(jobId, 'error', { message: err instanceof Error ? err.message : String(err) });
  } finally {
    jobs.delete(jobId);
  }
}

/**
 * docs/ROADMAP.md §8.12 — continues an HLS job that got no chance to reach any terminal state
 * before this Offscreen Document (and everything it was doing) died — a real browser crash/close,
 * or a manual extension reload while a download was in flight. Every early-return path here clears
 * the checkpoint AND reports an error explaining why resume wasn't possible, so the user isn't left
 * staring at a "Resume" row that will never work again; a fresh Download from scratch is always the
 * fallback the message points at.
 *
 * Deliberately re-derives almost everything from scratch rather than trusting the checkpoint's own
 * numbers: the manifest is refetched+reparsed (docs/ROADMAP.md §7.4's existing machinery, since a
 * signed segment URL list can rot between sessions exactly like a mid-run refresh), and the OPFS
 * file's real `size` is what decides whether `lastConfirmedByteOffset` can be trusted at all
 * (opfs-store.ts's `tryResumeOpfsRun`) — the checkpoint is a HINT for where to resume, never a fact
 * taken on faith.
 */
async function resumeJobFromCheckpoint(checkpoint: DownloadJobCheckpoint): Promise<void> {
  const { jobId } = checkpoint;
  if (jobs.has(jobId)) return; // already running (e.g. a duplicate click) — same guard as startJob
  const control: JobControl = {
    cancelled: false,
    pausedPromise: null,
    resolvePause: null,
    segmentsDone: 0,
    segmentsTotal: 0,
    bytesDownloaded: 0,
    startedAt: Date.now(),
    abortControllers: new Set(),
    inFlight: 0,
    kind: 'segments',
    live: false, // §8.12 explicitly refuses to resume a checkpoint whose manifest has since gone live
  };
  jobs.set(jobId, control);
  debugLog(jobId, `RESUME_CHECKPOINT — opfsRunId=${checkpoint.opfsRunId}, resuming from segment index ${checkpoint.lastConfirmedSegmentIndex + 1}/${checkpoint.total}`);
  try {
    const replayHeadersFor = await createReplayHeaderApplier(checkpoint.manifestUrl);

    let manifest: ParsedManifest;
    try {
      await replayHeadersFor(checkpoint.manifestUrl);
      const text = await (await fetch(checkpoint.manifestUrl)).text();
      manifest = parseM3u8(text, checkpoint.manifestUrl);
    } catch (err) {
      console.error(`Synapse download engine: job ${jobId} failed to refetch the manifest to resume`, err);
      emit(jobId, 'error', { message: `Could not refetch the manifest to resume: ${err instanceof Error ? err.message : String(err)}. Start a fresh download instead.` });
      return;
    }

    // docs/ROADMAP.md §8.12's mandatory safety checks — any of these means the manifest moved on
    // too much (or too little) since the checkpoint was saved to trust a byte-for-byte continuation.
    if (manifest.kind !== 'media') {
      emit(jobId, 'error', { message: 'This URL no longer looks like a resumable media playlist (it changed since the last attempt) — start a fresh download instead.' });
      return;
    }
    if (manifest.isLive) {
      emit(jobId, 'error', { message: 'This is now a live/sliding-window stream — there is no fixed segment set to safely resume. Start a fresh download instead.' });
      return;
    }
    if (manifest.segments.length <= checkpoint.lastConfirmedSegmentIndex) {
      emit(jobId, 'error', { message: 'The manifest now has fewer segments than were already downloaded — it changed too much to resume safely. Start a fresh download instead.' });
      return;
    }
    const drmSegment = manifest.segments.find((s) => s.key && isRealDrm(s.key));
    if (drmSegment?.key) {
      const key = drmSegment.key;
      emit(jobId, 'error', {
        message: `This stream is DRM-protected (METHOD=${key.method}${key.keyFormat ? `, KEYFORMAT=${key.keyFormat}` : ''}). Synapse cannot and will not attempt to download or remux DRM-protected content.`,
      });
      return;
    }

    const opfsRun = await tryResumeOpfsRun(checkpoint.opfsRunId, checkpoint.lastConfirmedByteOffset);
    if (!opfsRun) {
      emit(jobId, 'error', { message: "The partially-downloaded file is missing (or smaller than expected) — can't resume safely. Start a fresh download instead." });
      return;
    }

    await runJob(jobId, control, manifest, checkpoint.manifestUrl, replayHeadersFor, {
      resolutionLabel: checkpoint.resolutionLabel,
      resume: { runId: checkpoint.opfsRunId, opfsRun, startIndex: checkpoint.lastConfirmedSegmentIndex + 1 },
    });
  } catch (err) {
    console.error(`Synapse download engine: job ${jobId} failed to resume`, err);
    emit(jobId, 'error', { message: err instanceof Error ? err.message : String(err) });
  } finally {
    jobs.delete(jobId);
    // Every early-return above (and runJob's own `finally`, on the success path) needs the
    // checkpoint gone either way — cheap to also clear it here so no early-return branch above can
    // forget it individually. Idempotent no-op if runJob already cleared it.
    void clearCheckpoint(jobId);
  }
}

/** docs/ROADMAP.md §8.12 — present only when `runJob` is continuing a previously-interrupted job
 * (resumeJobFromCheckpoint above) rather than starting a fresh one. */
interface RunJobResumeState {
  runId: string;
  opfsRun: OpfsRun;
  /** 0-based index to start fetching/writing from — everything before it is already durably on
   * disk in `opfsRun`'s file (verified against its real size before this is ever constructed). */
  startIndex: number;
}

interface RunJobOptions {
  resolutionLabel?: string | undefined;
  resume?: RunJobResumeState | undefined;
}

async function runJob(
  jobId: string,
  control: JobControl,
  manifest: Extract<ParsedManifest, { kind: 'media' }>,
  sourceUrl: string,
  replayHeadersFor: (url: string) => Promise<void>,
  options: RunJobOptions = {},
): Promise<void> {
  const runId = options.resume?.runId ?? crypto.randomUUID();
  const opfsRun = options.resume?.opfsRun ?? (await createOpfsRun(runId));
  const total = manifest.segments.length;
  const startIndex = options.resume?.startIndex ?? 0;
  control.segmentsTotal = total;
  control.segmentsDone = startIndex; // §8.12 resume: everything before this index is already on disk
  debugLog(
    jobId,
    `runJob ${options.resume ? 'RESUMING' : 'starting'} — runId=${runId}, ${total} segment(s) total${options.resume ? `, starting at index ${startIndex}` : ''}, pool=${Math.min(SEGMENT_POOL_SIZE, total - startIndex)}`,
  );

  // docs/ROADMAP.md #7.4 — replaced WHOLESALE (not spliced by index) once a rotating-signature CDN
  // reissues the manifest; safe under the concurrent pool because only not-yet-fetched indices ever
  // read `segments` again.
  let segments = manifest.segments;
  let refreshBudgetSpent = false;
  let authDiagnosticLogged = false;

  async function ensureRefreshed(triggeringIndex: number): Promise<boolean> {
    if (refreshBudgetSpent || manifest.isLive) return false;
    refreshBudgetSpent = true;
    const refreshed = await tryRefreshSegmentsFromIndex(sourceUrl, triggeringIndex, replayHeadersFor);
    if (!refreshed) return false;
    segments = refreshed;
    return true;
  }

  /** docs/ROADMAP.md #7.1 — one-shot diagnostic on the FIRST segment 401/403 of a job, console-only
   * (no Tab UI to surface it in anymore — the offscreen document's console is reachable via
   * chrome://extensions' "Inspect views", same as the background service worker's). Simplified from
   * the old Merge-page version: that one also diagnosed a "wrong tabIds" mismatch, which no longer
   * applies now every fetch here uses the same TAB_ID_NONE scope background's own fetches already
   * share (see this file's top doc comment). */
  async function logSegmentAuthDiagnostics(url: string, statusCode: number): Promise<void> {
    if (authDiagnosticLogged) return;
    authDiagnosticLogged = true;
    try {
      const host = new URL(url).hostname;
      const replay = await requestFromBackground<DescribeHeaderReplayResult>({ type: 'synapse:describe-header-replay', host });
      const likelyCause = !replay.intended
        ? `No headers were captured for this manifest, or syncHeaderReplayRule was never called for ${host} — the CDN saw a bare extension request.`
        : !replay.liveRule
          ? `Rule ${replay.intended.ruleId} was synced for ${host} but is not in the live session ruleset — evicted by MAX_HOSTS, or updateSessionRules failed (check for an earlier console error from header-replay-rules).`
          : `Rule ${replay.intended.ruleId} is live and carries ${replay.intended.headerNames.join(', ')}. So either (a) Chrome overrode a value after the rule applied (it does this for Origin on CORS-mode requests), or (b) this CDN gates on something other than these headers.`;
      console.warn(`Synapse: segment fetch got HTTP ${statusCode} — header replay did not satisfy ${host}.\n\nLikely cause: ${likelyCause}`, {
        segmentUrl: url,
        manifestUrl: sourceUrl,
        ...replay,
      });
    } catch {
      // Diagnostics must never mask the real error the caller is already reporting.
    }
  }

  /**
   * docs/ROADMAP.md #8.3 — retries a segment up to 3 times (exponential backoff) before giving up;
   * still never skip-and-continue past exhausted retries (missing segment = broken video) — the
   * whole job still aborts once a segment fails every attempt.
   *
   * Bugfix (§8.1 follow-up): each attempt now gets its own `AbortController`, registered on
   * `control.abortControllers` — CANCEL used to just let whichever segment was already in flight
   * finish naturally (documented as an acceptable wait since segments are small), but in practice
   * that delay was long enough to be confusing: a fresh Download click right after Cancel would
   * silently no-op because the old job's entry hadn't settled out of `jobs`/`activeDownloads` yet,
   * reading as "it just resumed the previous session". `inFlight` tracking (`noteFetchSettled`) is
   * per ATTEMPT, not per segment — a segment sitting in its backoff sleep between attempts isn't
   * actually using the network, so it shouldn't hold up a PAUSE from settling into `'paused'`.
   */
  async function fetchSegment(index: number): Promise<ArrayBuffer> {
    return fetchAndDecryptSegment(() => segments[index]!, manifest.mediaSequence + index, `Segment ${index + 1}/${total}`, {
      jobId,
      control,
      replayHeadersFor,
      onAuthFailure: logSegmentAuthDiagnostics,
      tryRecoverExpiredUrl: () => ensureRefreshed(index),
    });
  }

  // docs/ROADMAP.md #8.3 — pool of concurrent fetches; segments still land in the OPFS file in
  // ORIGINAL order regardless of which fetch finishes first (`pendingWrites` buffers out-of-order
  // arrivals, `writeChain` serializes the actual OPFS writes one at a time).
  const pendingWrites = new Map<number, ArrayBuffer>();
  let nextToWrite = startIndex;
  let nextToFetch = startIndex;
  let writeChain: Promise<void> = Promise.resolve();

  // docs/ROADMAP.md §8.12 — periodic, not per-segment: a stream can have hundreds/thousands of
  // segments, and every round costs a `chrome.storage` round-trip PLUS (see `opfsRun.commit()`'s
  // doc comment) an O(current-file-size) swap-file re-copy inside OPFS itself — closing and
  // reopening the writable is the only way to make bytes actually durable/readable before the run
  // finishes, but it is genuinely not free for a large file. Spaced out much further than the
  // Side Panel's `scheduleRender` (§8.9) coalescing for exactly that reason: this isn't "don't
  // rebuild the DOM 60x/sec," it's "don't re-copy a 500MB file every few seconds."
  const CHECKPOINT_INTERVAL_MS = 20_000;
  let lastCheckpointAt = 0;
  // Tracks the most recently FIRED checkpoint save so the job's `finally` block (below) can await
  // it before clearing the checkpoint on completion — without this, the very last save (fired
  // fire-and-forget from `enqueueWrite`'s callback right as the final segment lands) could still be
  // in flight to background when the completion `clearCheckpoint` message goes out, and arrive
  // AFTER it: a checkpoint for an already-fully-downloaded job would be left behind, resurrecting a
  // stale "Resume available" row for something that doesn't need resuming.
  let pendingCheckpointSave: Promise<void> = Promise.resolve();

  /**
   * docs/ROADMAP.md §8.12 — bugfix found via a REAL crash-and-resume test that failed every time:
   * this used to read `opfsRun.bytesWritten()` and persist it as `lastConfirmedByteOffset` WITHOUT
   * ever calling `opfsRun.commit()` first — `FileSystemWritableFileStream.write()` only buffers into
   * a swap file, so none of those bytes were actually visible/durable yet, and `tryResumeOpfsRun`'s
   * "is the file at least this big?" check failed 100% of the time (see opfs-store.ts's `commit()`
   * doc comment for the full explanation). `commit()` must complete BEFORE the checkpoint is
   * persisted — a failed commit (thrown, caught here) means this round genuinely didn't happen, so
   * it must not save a checkpoint claiming otherwise; it just tries again at the next interval.
   */
  async function maybeSaveCheckpoint(): Promise<void> {
    const now = Date.now();
    if (now - lastCheckpointAt < CHECKPOINT_INTERVAL_MS) return;
    lastCheckpointAt = now;
    try {
      await opfsRun.commit();
    } catch (err) {
      debugLog(jobId, 'checkpoint commit() failed — skipping this checkpoint round, will retry next interval', { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const checkpoint: DownloadJobCheckpoint = {
      jobId,
      manifestUrl: sourceUrl,
      opfsRunId: runId,
      lastConfirmedSegmentIndex: control.segmentsDone - 1,
      lastConfirmedByteOffset: opfsRun.bytesWritten(),
      total,
      resolutionLabel: options.resolutionLabel,
    };
    debugLog(jobId, `saving checkpoint — lastConfirmedSegmentIndex=${checkpoint.lastConfirmedSegmentIndex}, byteOffset=${checkpoint.lastConfirmedByteOffset}`);
    pendingCheckpointSave = persistCheckpoint(checkpoint);
  }

  /**
   * Bugfix: `inFlight` used to be tracked per FETCH ATTEMPT, decremented the instant `fetchSegment`
   * settled — but a successful fetch's bytes still have to pass through `pendingWrites`/`flushReady`
   * and this `writeChain` before its `'segments'` progress event actually goes out. That write is
   * fully asynchronous and NOT bounded by `inFlight`, so the sequence could be: last in-flight fetch
   * settles → `inFlight` hits 0 while a PAUSE is pending → engine emits `'paused'` → THEN the queued
   * write for that same segment finishes and emits `'segments'` right after, silently overwriting
   * `'paused'` back to an active phase. From the UI this looked exactly like the report: Pause never
   * actually flips the button to Resume. `inFlight` now spans the WHOLE claimed-segment lifecycle
   * (fetch — including retries — AND its eventual write), incremented once per `worker()` claim and
   * decremented exactly once either here (write path) or in `worker()`'s catch (failure path) — never
   * per attempt — so there is no gap where the counter can read 0 before every side effect of a
   * claimed segment has actually happened.
   */
  function enqueueWrite(index: number, bytes: ArrayBuffer): void {
    writeChain = writeChain.then(async () => {
      await opfsRun.write(new Uint8Array(bytes));
      debugLog(jobId, `segment ${index + 1}/${total} written to OPFS`);
      control.segmentsDone = index + 1;
      const elapsedMs = Date.now() - control.startedAt;
      const bytesPerSec = control.bytesDownloaded / Math.max(elapsedMs / 1000, 1);
      // docs/ROADMAP.md §8.1 — estimate only: derived from THIS job's own observed throughput so
      // far, not from manifest duration (ManifestSegment carries no per-segment duration). "~" is
      // the UI's job to add; this is just the number.
      const etaMs = control.segmentsDone > 0 ? Math.round(((total - control.segmentsDone) * elapsedMs) / control.segmentsDone) : undefined;
      emit(jobId, 'segments', { segmentsDone: control.segmentsDone, segmentsTotal: total, bytesPerSec, etaMs });
      noteFetchSettled(jobId, control);
      // Awaited (not fire-and-forget) — `maybeSaveCheckpoint`'s `opfsRun.commit()` closes and
      // reopens the writable, and the NEXT queued write on this same `writeChain` must not run
      // until that reopen has actually completed.
      await maybeSaveCheckpoint();
    });
  }

  function flushReady(): void {
    while (pendingWrites.has(nextToWrite)) {
      const bytes = pendingWrites.get(nextToWrite)!;
      pendingWrites.delete(nextToWrite);
      enqueueWrite(nextToWrite, bytes);
      nextToWrite++;
    }
  }

  async function worker(): Promise<void> {
    for (;;) {
      if (control.cancelled) return;
      // docs/ROADMAP.md §8.1 — pauses at a segment boundary: an in-flight fetch (claimed before
      // PAUSE arrived) is allowed to finish, only the NEXT claim blocks here.
      if (control.pausedPromise) await control.pausedPromise;
      if (control.cancelled) return;
      const index = nextToFetch++;
      if (index >= total) return;
      control.inFlight++; // spans fetch (incl. retries) through this segment's eventual write — see enqueueWrite's doc comment
      let bytes: ArrayBuffer;
      try {
        bytes = await fetchSegment(index);
      } catch (err) {
        noteFetchSettled(jobId, control); // no write will happen for this segment — settle here instead
        // A CANCEL-triggered abort throws too (fetchSegment's own AbortController), but
        // `control.cancelled` is already true by the time it does — `cancelJob` sets it
        // synchronously before calling `.abort()`. That's a true cancellation, not a real failure,
        // so this worker must RETURN (not throw): `runJob`'s `if (control.cancelled)` check after
        // `Promise.all` only sees a clean cancel when EVERY worker returns normally — a rethrow here
        // would route it through the `catch` below instead and misreport it as an error.
        if (control.cancelled) {
          debugLog(jobId, `segment ${index + 1}/${total} — worker returning cleanly (cancelled)`);
          return;
        }
        debugLog(jobId, `segment ${index + 1}/${total} — real failure, aborting whole job`, { error: err instanceof Error ? err.message : String(err) });
        control.cancelled = true;
        throw err;
      }
      if (control.cancelled) {
        // Fetched successfully but CANCEL landed in the meantime (e.g. another worker's segment
        // failed for real) — this segment is being discarded without ever reaching `enqueueWrite`,
        // so its `inFlight++` above must still be balanced here, or it leaks forever.
        noteFetchSettled(jobId, control);
        return;
      }
      pendingWrites.set(index, bytes);
      flushReady();
    }
  }

  try {
    // §8.12 resume: the init segment (if any) is always the very first bytes written, before any
    // worker starts — by the time a checkpoint exists to resume FROM, it must already be on disk.
    if (manifest.initSegment && !options.resume) {
      debugLog(jobId, 'fetching init segment (#EXT-X-MAP)');
      const initBytes = await fetchInitSegmentBytes(manifest.initSegment, manifest.mediaSequence, replayHeadersFor, logSegmentAuthDiagnostics);
      await opfsRun.write(new Uint8Array(initBytes));
      debugLog(jobId, 'init segment written');
    }

    const workerCount = Math.min(SEGMENT_POOL_SIZE, Math.max(total - startIndex, 0));
    debugLog(jobId, `spinning up ${workerCount} worker(s)`);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    debugLog(jobId, `all workers returned — cancelled=${control.cancelled}`);

    // Reached only when every worker RETURNED (not threw) — either every segment succeeded, or a
    // CANCEL fired and every worker exited early via the `cancelled` checks above with no error.
    if (control.cancelled) {
      await writeChain.catch(() => {});
      await opfsRun.abort();
      emit(jobId, 'cancelled');
      return;
    }

    await writeChain;
    debugLog(jobId, 'writeChain drained — finishing OPFS run and producing output');
    const file = await opfsRun.finish();
    // An init segment is what distinguishes fMP4 from MPEG-TS, so it also decides the container the
    // concatenated bytes already are.
    await produceOutput(jobId, file, sourceUrl, manifest.initSegment ? 'mp4' : 'ts');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Synapse download engine: job ${jobId} failed`, err);
    await writeChain.catch(() => {});
    await opfsRun.abort();
    emit(jobId, 'error', { message });
  } finally {
    // docs/ROADMAP.md §8.12 — cleared on EVERY terminal outcome (done/error/cancelled), not just
    // success: a checkpoint only exists to survive an INTERRUPTION (crash/reload) the job never got
    // a chance to react to. A real in-session error still means "start over" (same philosophy as
    // fetchSegment's own exhausted-retries path) — it does not leave a resumable checkpoint behind.
    // Awaiting the last in-flight save first (see `pendingCheckpointSave`'s doc comment) guarantees
    // this clear is the LAST checkpoint-related message background sees for this jobId.
    await pendingCheckpointSave.catch(() => {});
    void clearCheckpoint(jobId);
    void removeOpfsRun(runId).catch(() => {});
  }
}

/** docs/ROADMAP.md §10.1 — HLS's own recommended re-poll cadence is the playlist's own
 * `#EXT-X-TARGETDURATION`; this is only the fallback for a manifest that omits it. */
const LIVE_POLL_FALLBACK_MS = 5000;
const MAX_CONSECUTIVE_LIVE_POLL_FAILURES = 5;

/**
 * docs/ROADMAP.md §10.1 — a live/sliding-window HLS manifest has no fixed segment set, so this is
 * NOT `runJob` with a bigger `total`: it's a sequential poll-fetch-write loop, not a pool. New
 * segments show up one at a time at roughly `targetDurationSec` cadence, so there's no backlog to
 * parallelize the way VOD's `SEGMENT_POOL_SIZE` workers do — sequential fetch also means writes land
 * in order for free, with no `pendingWrites`/`flushReady` reordering buffer needed. Segment identity
 * across polls is tracked by absolute HLS media-sequence number (`manifest.mediaSequence + i`), not
 * array index — a live playlist's window slides, so index `i` doesn't name the same segment across
 * two fetches (docs/ROADMAP.md #7.4's existing rationale for refusing wholesale index-remap on live).
 *
 * Ends one of three ways: `control.cancelled` (user Cancel — discard, same as VOD); the manifest
 * gains `#EXT-X-ENDLIST` (stream ended naturally); or `control.liveStopRequested` (user clicked Stop,
 * §10.1's `STOP_LIVE` command) — the latter two both drain whatever's already queued from the most
 * recent poll, then fall through to the SAME finish path as VOD (`opfsRun.finish()` →
 * `produceOutput()`, one remux at the very end, same `REMUX_SIZE_CAP_BYTES` fallback).
 *
 * Deliberately does NOT checkpoint (no `persistCheckpoint`/`opfsRun.commit()` calls) — see
 * docs/ROADMAP.md §10.1's "Explicitly out of scope" note: `commit()` is O(current file size) and this
 * file has no final size, and a live capture interrupted by an Offscreen Document restart is simply
 * lost (same as Cancel), matching the codebase's existing explicit refusal to resume a stream that
 * has since gone live (see `resumeJobFromCheckpoint`/`ensureRefreshed` above).
 */
async function runLiveJob(
  jobId: string,
  control: JobControl,
  initialManifest: Extract<ParsedManifest, { kind: 'media' }>,
  sourceUrl: string,
  replayHeadersFor: (url: string) => Promise<void>,
): Promise<void> {
  const runId = crypto.randomUUID();
  const opfsRun = await createOpfsRun(runId);
  let manifest = initialManifest;
  let nextSequenceToFetch = initialManifest.mediaSequence;
  let authDiagnosticLogged = false;

  debugLog(jobId, `runLiveJob starting — runId=${runId}, initial mediaSequence=${initialManifest.mediaSequence}`);

  /** Same one-shot-per-job diagnostic as VOD's `logSegmentAuthDiagnostics` (§7.1) — kept as its own
   * copy rather than shared, since sharing would need threading `sourceUrl`/`authDiagnosticLogged`
   * across both closures for no real benefit (this is the only other call site). */
  async function logAuthDiagnostics(url: string, statusCode: number): Promise<void> {
    if (authDiagnosticLogged) return;
    authDiagnosticLogged = true;
    try {
      const host = new URL(url).hostname;
      const replay = await requestFromBackground<DescribeHeaderReplayResult>({ type: 'synapse:describe-header-replay', host });
      const likelyCause = !replay.intended
        ? `No headers were captured for this manifest, or syncHeaderReplayRule was never called for ${host} — the CDN saw a bare extension request.`
        : !replay.liveRule
          ? `Rule ${replay.intended.ruleId} was synced for ${host} but is not in the live session ruleset — evicted by MAX_HOSTS, or updateSessionRules failed (check for an earlier console error from header-replay-rules).`
          : `Rule ${replay.intended.ruleId} is live and carries ${replay.intended.headerNames.join(', ')}. So either (a) Chrome overrode a value after the rule applied (it does this for Origin on CORS-mode requests), or (b) this CDN gates on something other than these headers.`;
      console.warn(`Synapse: live segment fetch got HTTP ${statusCode} — header replay did not satisfy ${host}.\n\nLikely cause: ${likelyCause}`, { segmentUrl: url, manifestUrl: sourceUrl, ...replay });
    } catch {
      // Diagnostics must never mask the real error the caller is already reporting.
    }
  }

  try {
    if (manifest.initSegment) {
      debugLog(jobId, 'fetching init segment (#EXT-X-MAP)');
      const initBytes = await fetchInitSegmentBytes(manifest.initSegment, initialManifest.mediaSequence, replayHeadersFor, logAuthDiagnostics);
      await opfsRun.write(new Uint8Array(initBytes));
      debugLog(jobId, 'init segment written');
    }

    let consecutivePollFailures = 0;

    pollLoop: for (;;) {
      if (control.cancelled) break;

      // Fetch every segment the CURRENT manifest lists that hasn't been fetched yet, oldest first.
      for (let i = 0; i < manifest.segments.length; i++) {
        const absoluteSeq = manifest.mediaSequence + i;
        if (absoluteSeq < nextSequenceToFetch) continue;
        if (control.cancelled) break pollLoop;
        if (control.pausedPromise) await control.pausedPromise;
        if (control.cancelled) break pollLoop;

        const segment = manifest.segments[i]!;
        // Same mandatory guard as `startJob`'s initial check (docs/ROADMAP.md #5.3/#8.4) — a live
        // source could start using real DRM mid-capture even if the first poll didn't show any.
        if (segment.key && isRealDrm(segment.key)) {
          throw new Error(`This stream became DRM-protected mid-capture (METHOD=${segment.key.method}${segment.key.keyFormat ? `, KEYFORMAT=${segment.key.keyFormat}` : ''}) — stopping.`);
        }

        control.inFlight++;
        try {
          const bytes = await fetchAndDecryptSegment(() => segment, absoluteSeq, `Live segment #${absoluteSeq}`, {
            jobId,
            control,
            replayHeadersFor,
            onAuthFailure: logAuthDiagnostics,
          });
          await opfsRun.write(new Uint8Array(bytes));
          nextSequenceToFetch = absoluteSeq + 1;
          control.segmentsDone = nextSequenceToFetch - initialManifest.mediaSequence;
          debugLog(jobId, `live segment #${absoluteSeq} written to OPFS`);
          const elapsedMs = Date.now() - control.startedAt;
          const bytesPerSec = control.bytesDownloaded / Math.max(elapsedMs / 1000, 1);
          emit(jobId, 'segments', { segmentsDone: control.segmentsDone, bytesPerSec, live: true });
        } catch (err) {
          if (control.cancelled) break pollLoop;
          // One dropped segment shouldn't kill an hours-long capture — log and move past it.
          console.warn(`Synapse: live capture ${jobId} skipping segment #${absoluteSeq} after exhausted retries`, err);
          nextSequenceToFetch = absoluteSeq + 1;
        } finally {
          noteFetchSettled(jobId, control);
        }
      }

      if (control.cancelled) break;
      if (!manifest.isLive) control.liveStopRequested = true; // #EXT-X-ENDLIST showed up
      if (control.liveStopRequested) break;

      const waitMs = manifest.targetDurationSec ? manifest.targetDurationSec * 1000 : LIVE_POLL_FALLBACK_MS;
      debugLog(jobId, `live poll — waiting ${waitMs}ms before refetching manifest`);
      await new Promise((r) => setTimeout(r, waitMs));
      if (control.cancelled) break;
      if (control.pausedPromise) await control.pausedPromise;
      if (control.cancelled) break;
      if (control.liveStopRequested) break; // STOP_LIVE may have arrived during the wait/pause above

      try {
        await replayHeadersFor(sourceUrl);
        const text = await (await fetch(sourceUrl)).text();
        const reparsed = parseM3u8(text, sourceUrl);
        if (reparsed.kind !== 'media') throw new Error('This URL no longer looks like a media playlist.');
        manifest = reparsed;
        consecutivePollFailures = 0;
      } catch (err) {
        consecutivePollFailures++;
        debugLog(jobId, `live manifest poll failed (${consecutivePollFailures}/${MAX_CONSECUTIVE_LIVE_POLL_FAILURES})`, { error: err instanceof Error ? err.message : String(err) });
        if (consecutivePollFailures >= MAX_CONSECUTIVE_LIVE_POLL_FAILURES) {
          throw new Error(`Could not refetch the live manifest after ${MAX_CONSECUTIVE_LIVE_POLL_FAILURES} attempts: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (control.cancelled) {
      await opfsRun.abort();
      emit(jobId, 'cancelled');
      return;
    }

    debugLog(jobId, 'live capture stopped — finishing OPFS run and producing output');
    const file = await opfsRun.finish();
    await produceOutput(jobId, file, sourceUrl, initialManifest.initSegment ? 'mp4' : 'ts');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Synapse download engine: live job ${jobId} failed`, err);
    await opfsRun.abort();
    emit(jobId, 'error', { message });
  }
}

/**
 * docs/ROADMAP.md §8.2 — opt-in "Turbo download": a multi-connection Range downloader for a plain
 * static `video`/`audio` file, used only when the Side Panel's Turbo toggle is on (default off).
 * Unlike the HLS job above, there's no manifest, no format conversion, no remux — the output is
 * exactly the source bytes, so the only job here is fetching N byte-ranges in parallel and landing
 * each one at its own OPFS offset the instant it arrives.
 */
const TURBO_CHUNK_COUNT = 6; // within the roadmap's stated 4–8 pool size
const MIN_TURBO_SIZE_BYTES = 5 * 1024 * 1024; // below this, N-connection overhead isn't worth it

interface RangeProbeResult {
  contentLength: number;
}

/**
 * docs/ROADMAP.md §8.2 — `HEAD` first (checks both `Content-Length` and `Accept-Ranges: bytes`).
 * Broadened slightly from the roadmap's literal wording: the `GET Range: bytes=0-0` fallback fires
 * whenever HEAD didn't CONCLUSIVELY confirm range support (missing/wrong `Accept-Ranges` on an
 * otherwise-200 response also triggers it), not only on a HEAD 405 — plenty of real servers support
 * ranges without advertising the header, and the fallback probe is cheap regardless of why HEAD came
 * up short. Returns `undefined` on any failure to confirm — caller falls back to `chrome.downloads`.
 */
async function probeRangeSupport(url: string, replayHeadersFor: (url: string) => Promise<void>): Promise<RangeProbeResult | undefined> {
  await replayHeadersFor(url);
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (head.ok) {
      const length = Number(head.headers.get('Content-Length'));
      if (head.headers.get('Accept-Ranges') === 'bytes' && Number.isFinite(length) && length > 0) {
        return { contentLength: length };
      }
    }
  } catch {
    // Fall through to the ranged-GET probe below.
  }
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    await res.arrayBuffer().catch(() => {}); // drain the tiny 1-byte body
    if (res.status !== 206) return undefined;
    const contentRange = res.headers.get('Content-Range'); // "bytes 0-0/12345"
    const total = contentRange ? Number(contentRange.split('/')[1]) : NaN;
    return Number.isFinite(total) && total > 0 ? { contentLength: total } : undefined;
  } catch {
    return undefined;
  }
}

async function startTurboJob(jobId: string, url: string): Promise<void> {
  if (jobs.has(jobId)) return; // already running
  const control: JobControl = {
    cancelled: false,
    pausedPromise: null,
    resolvePause: null,
    segmentsDone: 0,
    segmentsTotal: 0,
    bytesDownloaded: 0,
    startedAt: Date.now(),
    abortControllers: new Set(),
    inFlight: 0,
    kind: 'chunks',
    live: false, // turbo is a plain Range downloader, never manifest-driven — never live
  };
  jobs.set(jobId, control);
  debugLog(jobId, `START_TURBO — url=${url}`);
  try {
    const replayHeadersFor = await createReplayHeaderApplier(url);
    const probe = await probeRangeSupport(url, replayHeadersFor);
    debugLog(jobId, 'range probe result', probe ? { contentLength: probe.contentLength } : { supported: false });

    if (control.cancelled) {
      emit(jobId, 'cancelled');
      return;
    }

    // docs/ROADMAP.md §8.2 — "Không xác nhận được → im lặng dùng chrome.downloads." Same silent
    // fallback for a file too small for N-connection overhead to be worth it (not in the original
    // spec text, but the reasoning is identical).
    if (!probe || probe.contentLength < MIN_TURBO_SIZE_BYTES) {
      debugLog(jobId, 'falling back to chrome.downloads.download (no/weak range support, or file too small)');
      chrome.downloads.download({ url });
      emit(jobId, 'done', { message: 'Downloaded directly — this server or file is not a good fit for Turbo download.' });
      return;
    }

    const total = probe.contentLength;
    const chunkCount = TURBO_CHUNK_COUNT;
    const chunkSize = Math.ceil(total / chunkCount);
    control.segmentsTotal = chunkCount;
    debugLog(jobId, `${chunkCount} chunk(s) of ~${chunkSize} bytes each, total ${total} bytes`);

    const runId = crypto.randomUUID();
    const opfsRun = await createOpfsRun(runId);
    let writeChain: Promise<void> = Promise.resolve();
    let doneCount = 0;

    /**
     * One large ranged GET per chunk, retried with backoff like HLS's `fetchSegment` — same
     * per-attempt `AbortController` (registered on `control.abortControllers`) so CANCEL interrupts
     * immediately even mid-transfer through a chunk that could be hundreds of MB.
     */
    async function fetchChunk(index: number): Promise<void> {
      const start = index * chunkSize;
      const end = Math.min(start + chunkSize, total) - 1;
      if (start > end) return; // chunkCount doesn't evenly divide total — nothing left for this index
      const MAX_ATTEMPTS = 4;
      let lastError: unknown;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (control.cancelled) return;
        if (control.pausedPromise) await control.pausedPromise; // boundary-only — see JobControl's doc comment
        if (control.cancelled) return;
        const controller = new AbortController();
        control.abortControllers.add(controller);
        control.inFlight++;
        try {
          debugLog(jobId, `chunk ${index + 1}/${chunkCount} attempt ${attempt + 1}/${MAX_ATTEMPTS} — fetching bytes=${start}-${end}`);
          await replayHeadersFor(url);
          const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: controller.signal });
          debugLog(jobId, `chunk ${index + 1}/${chunkCount} attempt ${attempt + 1}/${MAX_ATTEMPTS} — HTTP ${res.status}`);
          if (res.status !== 206 && res.status !== 200) throw new Error(`Part ${index + 1} failed: HTTP ${res.status}`);
          const bytes = new Uint8Array(await res.arrayBuffer());
          control.bytesDownloaded += bytes.byteLength;
          writeChain = writeChain.then(() => opfsRun.write(bytes, start));
          await writeChain;
          debugLog(jobId, `chunk ${index + 1}/${chunkCount} written to OPFS`);
          doneCount++;
          control.segmentsDone = doneCount;
          const elapsedMs = Date.now() - control.startedAt;
          const bytesPerSec = control.bytesDownloaded / Math.max(elapsedMs / 1000, 1);
          const etaMs = doneCount > 0 ? Math.round(((chunkCount - doneCount) * elapsedMs) / doneCount) : undefined;
          emit(jobId, 'chunks', { segmentsDone: doneCount, segmentsTotal: chunkCount, bytesPerSec, etaMs });
          return;
        } catch (err) {
          lastError = err;
          debugLog(jobId, `chunk ${index + 1}/${chunkCount} attempt ${attempt + 1}/${MAX_ATTEMPTS} — threw`, { error: err instanceof Error ? err.message : String(err) });
        } finally {
          control.abortControllers.delete(controller);
          // Tracked per ATTEMPT (not per chunk) on purpose: the backoff sleep AND the pause-boundary
          // wait below both happen between attempts, outside this try/finally, so a chunk that's
          // between retries or waiting on a RESUME isn't actually using the network right now and
          // must not hold up a PAUSE from settling into `'paused'` (see `noteFetchSettled`).
          noteFetchSettled(jobId, control);
        }
        if (control.cancelled) return; // CANCEL's abort() lands here as a caught error — don't retry it
        if (attempt < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 5000)));
      }
      debugLog(jobId, `chunk ${index + 1}/${chunkCount} — exhausted all ${MAX_ATTEMPTS} attempts, giving up`);
      // Same fail-fast handshake as HLS's `worker()`: mark the job cancelled BEFORE throwing so every
      // other in-flight chunk's next attempt-loop check sees it and stops claiming further retries,
      // then let `Promise.all` below propagate this rejection straight to the outer `catch` — never
      // through the `if (control.cancelled)` branch, which stays reachable only by a true CANCEL
      // command (every chunk returning normally, none throwing).
      control.cancelled = true;
      throw lastError instanceof Error ? lastError : new Error(`Part ${index + 1} failed after ${MAX_ATTEMPTS} attempts.`);
    }

    try {
      await Promise.all(Array.from({ length: chunkCount }, (_, i) => fetchChunk(i)));
      debugLog(jobId, `all chunks returned — cancelled=${control.cancelled}`);

      // Reached only when every chunk RETURNED (not threw) — i.e. a true CANCEL, not a real failure
      // (a real failure sets `cancelled` too, but THROWS, which `Promise.all` propagates straight to
      // the `catch` below instead of here — same distinction HLS's `runJob` relies on).
      if (control.cancelled) {
        await opfsRun.abort();
        emit(jobId, 'cancelled');
        return;
      }

      const file = await opfsRun.finish();
      debugLog(jobId, `OPFS run finished, ${file.size} bytes — handing to chrome.downloads`);
      downloadFile(file, fileNameFromUrl(url) || `download-${jobId}`);
      emit(jobId, 'done');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Synapse download engine: turbo job ${jobId} failed`, err);
      await opfsRun.abort();
      emit(jobId, 'error', { message });
    } finally {
      void removeOpfsRun(runId).catch(() => {});
    }
  } catch (err) {
    console.error(`Synapse download engine: turbo job ${jobId} failed`, err);
    emit(jobId, 'error', { message: err instanceof Error ? err.message : String(err) });
  } finally {
    jobs.delete(jobId);
  }
}

/** Which container the concatenated OPFS bytes already ARE — decided by whether the manifest
 * carried an `#EXT-X-MAP` init segment, not by preference. */
type OutputContainer = 'ts' | 'mp4';

/** Triggers the download from WITHIN this document — a blob: URL only resolves from the same
 * document that created it, which is exactly what chrome.offscreen.Reason.BLOBS exists for. */
/**
 * Bugfix: this used to call `chrome.downloads.download()` directly — throws
 * "Cannot read properties of undefined (reading 'download')" every time, since `chrome.downloads` is
 * one of the APIs unavailable to Offscreen Documents (see this file's `requestFromBackground` doc
 * comment). The blob: URL itself is still created HERE — it only resolves within the document that
 * created it — but the actual `chrome.downloads.download()` call is relayed to background, which
 * Chrome's own docs confirm as the supported pattern: create the object URL in the offscreen
 * document, message the URL string back, trigger the download from a context that has the API.
 */
function downloadFile(blob: Blob, fileName: string): void {
  const blobUrl = URL.createObjectURL(blob);
  chrome.runtime.sendMessage({ type: 'synapse:trigger-download', url: blobUrl, filename: fileName }).catch(() => {});
  // The blob: URL must stay valid until the download manager has actually read it — background's
  // chrome.downloads.download() only confirms the download was ACCEPTED, not that reading finished,
  // and that confirmation doesn't even round-trip back here. A flat delay is the best available
  // signal from this side.
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
}

/** docs/ROADMAP.md #8.5 — the "no ffmpeg" fast path: concatenated MPEG-TS is playable because TS is
 * self-syncing per 188-byte packet; concatenated fMP4 is playable because `init + moof/mdat + ...`
 * is precisely how a fragmented MP4 is laid out (the CMAF wire format), provided the init segment
 * was written first. Either way: no wasm, no memory ceiling, works at any size. */
function saveConcatenated(file: File, sourceUrl: string, container: OutputContainer): void {
  downloadFile(file, `${slugify(fileNameFromUrl(sourceUrl), 'stream')}.${container}`);
}

/** docs/ROADMAP.md #8.5 — `ffmpeg.mount('WORKERFS', ...)` hands the already-concatenated OPFS file
 * to ffmpeg WITHOUT copying it into MEMFS first, halving the memory peak on the input side; reads it
 * directly as one stream so no concat demuxer/file list is needed. */
async function remuxToMp4(file: File, sourceUrl: string, jobId: string): Promise<void> {
  emit(jobId, 'remux');
  const ffmpeg = new FFmpeg();
  // Without this subscription @ffmpeg/ffmpeg prints NOTHING — its worker forwards ffmpeg's stderr
  // as 'log' events and drops them when nobody is listening.
  ffmpeg.on('log', ({ message }) => console.log(`ffmpeg (${jobId}): ${message}`));
  await ffmpeg.load({
    // Bundled with the extension (manifest.config.ts's `wasm-unsafe-eval` CSP, which also covers
    // this offscreen document — both fall under `extension_pages`), not fetched from a CDN.
    coreURL: chrome.runtime.getURL(ffmpegCoreUrl.replace(/^\//, '')),
    wasmURL: chrome.runtime.getURL(ffmpegWasmUrl.replace(/^\//, '')),
  });

  // Emscripten's FS.mount() requires the mount point to already exist — a fresh `ffmpeg` instance
  // is created per attempt, so '/input' never already exists here.
  await ffmpeg.createDir('/input');
  await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, '/input');

  try {
    const exitCode = await ffmpeg.exec(['-i', `/input/${file.name}`, '-c', 'copy', 'output.mp4']);
    if (exitCode !== 0) throw new Error(`ffmpeg exited with code ${exitCode} — see the offscreen document's console (chrome://extensions' "Inspect views") for its log.`);

    const output = await ffmpeg.readFile('output.mp4');
    if (typeof output === 'string') throw new Error('ffmpeg returned text instead of the expected binary output.');

    // `output.buffer` can type as `ArrayBufferLike` (possibly SharedArrayBuffer) — copy into a
    // plain ArrayBuffer-backed Uint8Array, which is all `Blob`'s constructor accepts.
    downloadFile(new Blob([output.slice()], { type: 'video/mp4' }), `${slugify(fileNameFromUrl(sourceUrl), 'stream')}.mp4`);
    emit(jobId, 'done');
  } finally {
    await ffmpeg.unmount('/input');
  }
}

/** docs/ROADMAP.md #8.5/§8.1 — auto-picks ONE output path (remux under the size cap, otherwise the
 * always-safe direct save) with no manual retry buttons — there's no UI to click them from in a
 * headless engine, unlike the old Merge Tab's "Save (.ts, fast)"/"Remux → .mp4" pair. A remux
 * failure now falls back to the direct save automatically instead of leaving the job with nothing
 * downloadable — a deliberate improvement over the old page's behavior (which just reported the
 * error), since there is no interactive retry button left for the user to recover with. */
async function produceOutput(jobId: string, file: File, sourceUrl: string, container: OutputContainer): Promise<void> {
  if (file.size > REMUX_SIZE_CAP_BYTES) {
    saveConcatenated(file, sourceUrl, container);
    emit(jobId, 'done');
    return;
  }
  try {
    await remuxToMp4(file, sourceUrl, jobId);
  } catch (err) {
    console.warn(`Synapse: remux failed for job ${jobId}, falling back to direct .${container} save`, err);
    saveConcatenated(file, sourceUrl, container);
    emit(jobId, 'done');
  }
}
