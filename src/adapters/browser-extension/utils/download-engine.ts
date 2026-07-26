import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
// `?url` (plain Vite feature, not crx's `?script&iife`) — fetched by the ffmpeg.wasm worker itself
// only once `ffmpeg.load()` actually runs, not eagerly at module load.
import ffmpegCoreUrl from '@ffmpeg/core?url';
import ffmpegWasmUrl from '@ffmpeg/core/wasm?url';
import { parseM3u8, type ManifestSegment, type ParsedManifest, type SegmentKey } from '../../../shared/media-manifest-parser';
import { slugify } from '../../../shared/slugify';
import type { DownloadEngineCommand, DownloadEngineEvent, DownloadEnginePhase } from '../../../shared/download-engine-protocol';
import { createOpfsRun, removeOpfsRun } from './opfs-store';
import { describeHeaderReplay, syncHeaderReplayRule } from './header-replay-rules';
import { listDetectedMedia } from '../background/modules/network-sniffer/store';

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
}

const jobs = new Map<string, JobControl>();

function emit(jobId: string, phase: DownloadEnginePhase, extra?: Partial<DownloadEngineEvent>): void {
  const event: DownloadEngineEvent = { type: 'synapse:download-engine-event', jobId, phase, ...extra };
  chrome.runtime.sendMessage(event).catch(() => {});
}

export function handleEngineCommand(cmd: DownloadEngineCommand): void {
  switch (cmd.op) {
    case 'START':
      if (cmd.url) void startJob(cmd.jobId, cmd.url);
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
  }
}

function pauseJob(jobId: string): void {
  const control = jobs.get(jobId);
  if (!control || control.pausedPromise) return;
  control.pausedPromise = new Promise((resolve) => {
    control.resolvePause = resolve;
  });
  emit(jobId, 'paused', { segmentsDone: control.segmentsDone, segmentsTotal: control.segmentsTotal });
}

function resumeJob(jobId: string): void {
  const control = jobs.get(jobId);
  if (!control?.pausedPromise) return;
  control.resolvePause?.();
  control.pausedPromise = null;
  control.resolvePause = null;
  emit(jobId, 'segments', { segmentsDone: control.segmentsDone, segmentsTotal: control.segmentsTotal });
}

/** Also wakes a paused worker loop (resolves `pausedPromise`) so it observes `cancelled` on its next
 * check and exits, instead of hanging forever waiting for a RESUME that will never come. */
function cancelJob(jobId: string): void {
  const control = jobs.get(jobId);
  if (!control) return;
  control.cancelled = true;
  control.resolvePause?.();
  control.pausedPromise = null;
  control.resolvePause = null;
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

/** docs/ROADMAP.md #7.1 — the entry that had this URL (as its own `url`, or as one of its
 * `variants`) is the one whose captured headers apply here. */
async function findReplayHeaders(url: string): Promise<Record<string, string> | undefined> {
  const all = await listDetectedMedia();
  return all.find((m) => m.url === url || m.variants?.some((v) => v.url === url))?.requestHeaders;
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

async function startJob(jobId: string, manifestUrl: string): Promise<void> {
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
  };
  jobs.set(jobId, control);
  try {
    const replayHeaders = await findReplayHeaders(manifestUrl).catch(() => undefined);
    const replayHeaderHostsSynced = new Set<string>();
    // No-ops when there are no captured headers, or this URL's host already has a rule synced this
    // job (segments overwhelmingly share one host with the manifest).
    async function replayHeadersFor(url: string): Promise<void> {
      if (!replayHeaders) return;
      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        return;
      }
      if (replayHeaderHostsSynced.has(host)) return;
      replayHeaderHostsSynced.add(host);
      await syncHeaderReplayRule(host, replayHeaders);
    }

    let manifest: ParsedManifest;
    try {
      await replayHeadersFor(manifestUrl);
      const text = await (await fetch(manifestUrl)).text();
      manifest = parseM3u8(text, manifestUrl);
    } catch {
      emit(jobId, 'error', { message: `Could not fetch this URL: ${manifestUrl}` });
      return;
    }

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

    await runJob(jobId, control, manifest, manifestUrl, replayHeadersFor);
  } catch (err) {
    emit(jobId, 'error', { message: err instanceof Error ? err.message : String(err) });
  } finally {
    jobs.delete(jobId);
  }
}

async function runJob(
  jobId: string,
  control: JobControl,
  manifest: Extract<ParsedManifest, { kind: 'media' }>,
  sourceUrl: string,
  replayHeadersFor: (url: string) => Promise<void>,
): Promise<void> {
  const runId = crypto.randomUUID();
  const opfsRun = await createOpfsRun(runId);
  const total = manifest.segments.length;
  control.segmentsTotal = total;

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
      const replay = await describeHeaderReplay(host);
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
   */
  async function fetchSegment(index: number): Promise<ArrayBuffer> {
    const MAX_ATTEMPTS = 4; // 1 initial try + 3 retries
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const segment = segments[index]!;
        await replayHeadersFor(segment.url);
        const res = await fetch(segment.url);
        if (res.status === 401 || res.status === 403) {
          await logSegmentAuthDiagnostics(segment.url, res.status);
          if (await ensureRefreshed(index)) continue; // retry now, doesn't consume a backoff wait
          throw new Error(
            `Segment ${index + 1} failed: HTTP ${res.status} — the link expired and no manifest refresh was available, ` +
              "or this CDN's hotlink protection rejected the request.",
          );
        }
        if (res.status === 404 || res.status === 410) {
          if (await ensureRefreshed(index)) continue;
          throw new Error(
            manifest.isLive
              ? `Segment ${index + 1} is already gone (HTTP ${res.status}). This playlist carries no #EXT-X-ENDLIST, so it is a live/sliding-window stream: segments expire out of the window as it advances, and there is no fixed set of them to save.`
              : `Segment ${index + 1} failed: HTTP ${res.status} — that segment URL is no longer served, and refreshing the manifest did not yield a working one.`,
          );
        }
        if (!res.ok) throw new Error(`Segment ${index + 1} failed: HTTP ${res.status}`);
        const bytes = await res.arrayBuffer();
        control.bytesDownloaded += bytes.byteLength;
        return segment.key ? await decryptSegment(bytes, segment.key, manifest.mediaSequence + index) : bytes;
      } catch (err) {
        lastError = err;
      }
      if (attempt < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 5000)));
    }
    throw lastError instanceof Error ? lastError : new Error(`Segment ${index + 1} failed after ${MAX_ATTEMPTS} attempts.`);
  }

  // docs/ROADMAP.md #8.3 — pool of concurrent fetches; segments still land in the OPFS file in
  // ORIGINAL order regardless of which fetch finishes first (`pendingWrites` buffers out-of-order
  // arrivals, `writeChain` serializes the actual OPFS writes one at a time).
  const pendingWrites = new Map<number, ArrayBuffer>();
  let nextToWrite = 0;
  let nextToFetch = 0;
  let writeChain: Promise<void> = Promise.resolve();

  function enqueueWrite(index: number, bytes: ArrayBuffer): void {
    writeChain = writeChain.then(async () => {
      await opfsRun.write(new Uint8Array(bytes));
      control.segmentsDone = index + 1;
      const elapsedMs = Date.now() - control.startedAt;
      const bytesPerSec = control.bytesDownloaded / Math.max(elapsedMs / 1000, 1);
      // docs/ROADMAP.md §8.1 — estimate only: derived from THIS job's own observed throughput so
      // far, not from manifest duration (ManifestSegment carries no per-segment duration). "~" is
      // the UI's job to add; this is just the number.
      const etaMs = control.segmentsDone > 0 ? Math.round(((total - control.segmentsDone) * elapsedMs) / control.segmentsDone) : undefined;
      emit(jobId, 'segments', { segmentsDone: control.segmentsDone, segmentsTotal: total, bytesPerSec, etaMs });
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
      let bytes: ArrayBuffer;
      try {
        bytes = await fetchSegment(index);
      } catch (err) {
        control.cancelled = true;
        throw err;
      }
      if (control.cancelled) return;
      pendingWrites.set(index, bytes);
      flushReady();
    }
  }

  /** The `#EXT-X-MAP` init segment, written as the FIRST bytes of the output file — fetched inline,
   * bypassing the pool/writeChain, since no worker has started yet at this point. */
  async function fetchInitSegment(init: ManifestSegment): Promise<ArrayBuffer> {
    await replayHeadersFor(init.url);
    const range = init.byteRange ? byteRangeToHeader(init.byteRange) : undefined;
    const res = await fetch(init.url, range ? { headers: { Range: range } } : {});
    if (res.status === 401 || res.status === 403) await logSegmentAuthDiagnostics(init.url, res.status);
    if (!res.ok) throw new Error(`Initialization segment failed: HTTP ${res.status} (${init.url})`);
    const bytes = await res.arrayBuffer();
    return init.key ? await decryptSegment(bytes, init.key, manifest.mediaSequence) : bytes;
  }

  try {
    if (manifest.initSegment) {
      await opfsRun.write(new Uint8Array(await fetchInitSegment(manifest.initSegment)));
    }

    const workerCount = Math.min(SEGMENT_POOL_SIZE, total);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    // Reached only when every worker RETURNED (not threw) — either every segment succeeded, or a
    // CANCEL fired and every worker exited early via the `cancelled` checks above with no error.
    if (control.cancelled) {
      await writeChain.catch(() => {});
      await opfsRun.abort();
      emit(jobId, 'cancelled');
      return;
    }

    await writeChain;
    const file = await opfsRun.finish();
    // An init segment is what distinguishes fMP4 from MPEG-TS, so it also decides the container the
    // concatenated bytes already are.
    await produceOutput(jobId, file, sourceUrl, manifest.initSegment ? 'mp4' : 'ts');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeChain.catch(() => {});
    await opfsRun.abort();
    emit(jobId, 'error', { message });
  } finally {
    void removeOpfsRun(runId).catch(() => {});
  }
}

/** Which container the concatenated OPFS bytes already ARE — decided by whether the manifest
 * carried an `#EXT-X-MAP` init segment, not by preference. */
type OutputContainer = 'ts' | 'mp4';

/** Triggers the download from WITHIN this document — a blob: URL only resolves from the same
 * document that created it, which is exactly what chrome.offscreen.Reason.BLOBS exists for. */
function downloadFile(blob: Blob, fileName: string): void {
  const blobUrl = URL.createObjectURL(blob);
  chrome.downloads.download({ url: blobUrl, filename: fileName }, () => {
    // The callback firing only means "accepted, download started" — not "finished reading the
    // blob". A short synchronous revoke would race the download manager still needing the URL.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  });
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
