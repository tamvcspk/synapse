import van from 'vanjs-core';
import '@picocss/pico/css/pico.min.css';
import './merge.css';
import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
// `?url` (plain Vite feature, not crx's `?script&iife`) — these two are fetched by the ffmpeg.wasm
// worker itself (via `import()`/`fetch()`) only once `ffmpeg.load()` actually runs, not eagerly at
// page load, even though the import sits at module top level; the string is just a URL.
import ffmpegCoreUrl from '@ffmpeg/core?url';
import ffmpegWasmUrl from '@ffmpeg/core/wasm?url';
import { parseM3u8, type ManifestSegment, type ParsedManifest, type SegmentKey } from '../../../../shared/media-manifest-parser';
import { slugify } from '../../../../shared/slugify';
import { createOpfsRun, removeOpfsRun } from '../../utils/opfs-store';
import { syncHeaderReplayRule } from '../../utils/header-replay-rules';
import { listDetectedMedia } from '../../background/modules/network-sniffer/store';

/**
 * Merge page (docs/ROADMAP.md #5.3) — a standalone Tab (opened via a `rowActions` 'open-tab'
 * action, kernel/ui-schema.ts, from network-sniffer's "Download (merged)" button) that turns an
 * HLS media/variant playlist into one downloadable .mp4: fetch every segment, remux with
 * ffmpeg.wasm (`-c copy`, no re-encode — the common TS-segment case only, see media-manifest-
 * parser.ts's doc comment on scope). Needs a real Tab, not the background service worker: ffmpeg.
 * wasm's worker + WebAssembly.instantiate only run in a page context. Scoped to a single `?url=`
 * (the manifest URL) — no module list of its own, same "one-shot, single-purpose page" shape as
 * ui/review/.
 */

const { header, h1, p, button, div } = van.tags;

const root = document.getElementById('root')!;
const searchParams = new URLSearchParams(location.search);
const manifestUrl = searchParams.get('url');
// docs/ROADMAP.md #7.6 — only set when this Tab was opened by the Side Panel (which tracks one
// in-flight download per detected-media entry); a manually-opened Merge tab (Dashboard's §6.8
// smart-download, or a bare `ui/merge/index.html?url=...`) has none, and postProgress below is a
// no-op in that case — nothing is listening for it anyway.
const entryId = searchParams.get('entryId') ?? undefined;

// docs/ROADMAP.md #8.3 — replaces the old strict-sequential fetch + fixed 200ms delay
// (crawlSite-style courteous pacing, docs/ROADMAP.md #1): the concurrency cap itself is already the
// "polite" limit here, stacking a per-segment delay on top penalized a long stream twice (a 1-hour
// video's ~600 segments cost 2 minutes in pure delay before this change).
const SEGMENT_POOL_SIZE = 5;

// docs/ROADMAP.md #8.5 — `ffmpeg.mount('WORKERFS', ...)` avoids copying the *input* into the wasm
// heap (MEMFS), but the *output* file ffmpeg produces still lands in MEMFS, and that's a wasm32
// linear-memory heap capped well under 4GB in practice. Conservative, unverified-at-runtime cap —
// above it, remux is skipped entirely and the concatenated .ts (already playable, no wasm involved)
// is saved directly instead. This is the actual OOM fix: previously EVERY stream went through
// ffmpeg regardless of size.
const REMUX_SIZE_CAP_BYTES = 2 * 1024 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// docs/ROADMAP.md #8.5 — tracks the OPFS run file backing the CURRENT attempt (Retry replaces it
// with a fresh runId/file, same "no resume, retry starts over" posture as before) so a Tab closed
// mid-run or right after finishing (§7.6 auto-closes the Tab shortly after 'done'/'error') doesn't
// leak an orphaned file in OPFS.
let currentRunId: string | undefined;
window.addEventListener('pagehide', () => {
  if (currentRunId) void removeOpfsRun(currentRunId);
});

/** docs/ROADMAP.md #7.6 — fire-and-forget progress relay to whichever Side Panel opened this Tab
 * (if any). No background relay needed: both are privileged extension pages, so the Side Panel can
 * `chrome.runtime.onMessage.addListener` directly. `sendMessage` rejects when nothing is listening
 * (e.g. this Tab was opened manually, or the Side Panel closed mid-download) — swallowed, since
 * that's an expected, harmless case here, not a bug. */
function postProgress(phase: 'segments' | 'remux' | 'done' | 'error', done?: number, total?: number, message?: string): void {
  if (!entryId) return;
  chrome.runtime.sendMessage({ type: 'synapse:merge-progress', entryId, phase, done, total, message }).catch(() => {});
}

function renderError(message: string): void {
  root.replaceChildren();
  van.add(root, header(h1('Download (merged)')), p({ class: 'merge-error' }, message));
  postProgress('error', undefined, undefined, message);
}

// docs/ROADMAP.md #7.1 — the manifest's/segments' Referer/Origin/User-Agent replay headers,
// captured at original detection time (webrequest-media-observer.ts) and looked up once in load()
// below. Module-scoped so run()'s per-segment fetches (well after load() returns) can reuse it
// without re-querying storage per segment.
let replayHeaders: Record<string, string> | undefined;
const replayHeaderHostsSynced = new Set<string>();

/** docs/ROADMAP.md #7.1 — the entry that had this URL (as its own `url`, or as one of its
 * `variants`) is the one whose captured headers apply here; a variant inherits its parent master
 * entry's headers since both were served by the same original page/CDN. */
async function findReplayHeaders(url: string): Promise<Record<string, string> | undefined> {
  const all = await listDetectedMedia();
  return all.find((m) => m.url === url || m.variants?.some((v) => v.url === url))?.requestHeaders;
}

/** This Tab's own id, needed to scope the header-replay rule to the fetches THIS page makes —
 * `TAB_ID_NONE` only covers the background service worker's own requests, never an extension page
 * rendered in a tab (see syncHeaderReplayRule's doc comment; this was why every segment download
 * went out without the captured Referer/Origin and 403'd on hotlink-protected CDNs). Resolved once,
 * lazily — `chrome.tabs.getCurrent()` needs no `tabs` permission. */
let selfTabIdPromise: Promise<number[]> | undefined;
function selfTabIds(): Promise<number[]> {
  selfTabIdPromise ??= chrome.tabs
    .getCurrent()
    .then((tab) => (tab?.id !== undefined ? [tab.id] : []))
    .catch(() => []);
  return selfTabIdPromise;
}

/** No-ops when there are no captured headers for this download, or this URL's host already has a
 * rule synced this run (segments overwhelmingly share one host with the manifest — this avoids
 * hundreds of redundant chrome.declarativeNetRequest calls for a long segment list). */
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
  await syncHeaderReplayRule(host, replayHeaders, await selfTabIds());
}

/**
 * docs/ROADMAP.md #8.4 — plain HLS segment encryption (`METHOD=AES-128`, key served in the clear
 * via the manifest's own `URI=`) is decrypted so these streams download like any other stream; real
 * DRM (`SAMPLE-AES`, or any `KEYFORMAT` other than `identity` — Widevine/PlayReady/FairPlay) is
 * refused outright, never attempted. This split is a hard security boundary, not a UI nicety — see
 * media-manifest-parser.ts's `SegmentKey` doc comment.
 */
function isRealDrm(key: SegmentKey): boolean {
  return key.method !== 'AES-128' || (key.keyFormat !== undefined && key.keyFormat.toLowerCase() !== 'identity');
}

// A run's segments overwhelmingly share one key (or a small handful across a key-rotating VOD
// playlist) — fetched once per key URI, not once per segment.
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
 * segment's media sequence number, big-endian, zero-padded to 16 bytes. Getting this wrong (e.g.
 * byte order) doesn't throw, it silently decrypts to garbage — there's no way to detect that here,
 * only by the caller noticing ffmpeg/playback rejects the result. */
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

/** `crypto.subtle.decrypt`'s AES-CBC mode strips PKCS#7 padding itself — the exact padding HLS's
 * AES-128 uses, no extra handling needed here. */
async function decryptSegment(bytes: ArrayBuffer, key: SegmentKey, sequenceNumber: number): Promise<ArrayBuffer> {
  const cryptoKey = await loadAesKey(key.uri);
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivForSegment(key, sequenceNumber) }, cryptoKey, bytes);
}

async function load(): Promise<void> {
  if (!manifestUrl) {
    renderError('No manifest URL given — open this page via a stream row\'s "Download (merged)" action in the Dashboard.');
    return;
  }

  replayHeaders = await findReplayHeaders(manifestUrl).catch(() => undefined);

  let manifest: ParsedManifest;
  try {
    await replayHeadersFor(manifestUrl);
    const text = await (await fetch(manifestUrl)).text();
    manifest = parseM3u8(text, manifestUrl);
  } catch {
    renderError(`Could not fetch this URL: ${manifestUrl}`);
    return;
  }

  if (manifest.kind === 'unknown') {
    renderError("This URL doesn't look like an HLS manifest (no #EXTINF or #EXT-X-STREAM-INF found in it).");
    return;
  }

  if (manifest.kind === 'master') {
    // Stale reference to a removed "Inspect" button fixed here (docs/ROADMAP.md §6.3 folded master-
    // playlist resolutions into `DetectedMedia.variants` automatically — there's no separate Inspect
    // step anymore, just a resolution picker on the entry itself).
    renderError(
      'This is a master playlist listing multiple resolutions, not a single downloadable stream. ' +
        'Pick a specific resolution from this video\'s list in the Side Panel or Dashboard instead.',
    );
    return;
  }

  render(manifest, manifestUrl);
}

function render(manifest: Extract<ParsedManifest, { kind: 'media' }>, sourceUrl: string): void {
  document.title = 'Synapse — Download (merged)';
  root.replaceChildren();

  // Mandatory guard, not optional (docs/ROADMAP.md #5.3/#8.4) — feeding a real-DRM (SAMPLE-AES, or
  // non-identity KEYFORMAT) segment into ffmpeg.wasm's `-c copy` doesn't fail loudly, it produces a
  // silently-corrupt file. Plain `AES-128` (identity KEYFORMAT) is NOT blocked here — run() below
  // decrypts it transparently before writing.
  const drmSegment = manifest.segments.find((s) => s.key && isRealDrm(s.key));
  if (drmSegment?.key) {
    const key = drmSegment.key;
    const message = `This stream is DRM-protected (METHOD=${key.method}${key.keyFormat ? `, KEYFORMAT=${key.keyFormat}` : ''}).`;
    van.add(
      root,
      header(h1('Download (merged)')),
      div(
        { class: 'merge-drm' },
        p(message),
        p('Synapse cannot and will not attempt to download or remux DRM-protected content.'),
      ),
    );
    postProgress('error', undefined, undefined, message);
    return;
  }

  const status = div({ class: 'merge-status' }, `${manifest.segments.length} segment(s) found. Starting download...`);
  // docs/ROADMAP.md #7.6 — the button is now only a manual retry after a failure; the normal path
  // runs immediately below, no click needed (the whole point of opening this Tab in the background).
  const startBtn = button({ type: 'button' }, 'Retry');
  const actions = div({ class: 'merge-actions' }, startBtn);
  startBtn.onclick = () => void run(manifest, sourceUrl, status, startBtn, actions);

  van.add(root, header(h1('Download (merged)'), p(sourceUrl)), status, actions);
  void run(manifest, sourceUrl, status, startBtn, actions);
}

/**
 * docs/ROADMAP.md #7.4 — a segment 401/403 mid-run usually means its signed URL expired, not that
 * the video vanished: refetching the SAME manifest almost always reissues the whole segment list
 * with fresh signatures. The caller (`run()`'s `ensureRefreshed`, docs/ROADMAP.md #8.3) replaces its
 * working `segments` array WHOLESALE with the result, by INDEX — that's the only stable key across
 * two fetches of a rotating-signature playlist, and is safe under §8.3's concurrent pool because
 * already-fetched-and-written indices are never re-read, only not-yet-fetched ones observe the
 * replacement. Only ever attempted once per run (budget tracked by the caller) and only when the
 * manifest is confirmed VOD (`!isLive`, media-manifest-parser.ts's `isLive`) — a live playlist's
 * segment window slides, so index i doesn't name the same segment in a re-fetch. Returns `undefined`
 * on any failure to refetch/reparse, or when the refreshed manifest can't be trusted (still live, or
 * too short to still have an entry at `fromIndex`) — the caller treats that the same as the original
 * failure and aborts.
 */
async function tryRefreshSegmentsFromIndex(
  manifestUrl: string,
  fromIndex: number,
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

/** Anchor-click download of an in-memory or file-backed Blob — shared by both output paths below. */
function downloadBlob(blob: Blob, fileName: string): void {
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(blobUrl);
}

/** docs/ROADMAP.md #8.5 — the "no ffmpeg" fast path: concatenated MPEG-TS segments are ALREADY a
 * playable .ts file (TS is self-syncing per 188-byte packet, unlike raw byte concatenation of most
 * other container formats) — `file` here is exactly that, written by the OPFS run in `run()` below.
 * No wasm, no memory ceiling, works at any size. */
function saveTs(file: File, sourceUrl: string): void {
  downloadBlob(file, `${slugify(fileNameFromUrl(sourceUrl), 'stream')}.ts`);
}

/** docs/ROADMAP.md #8.5 — remux path, only reachable for files under `REMUX_SIZE_CAP_BYTES`.
 * `ffmpeg.mount('WORKERFS', ...)` hands the already-concatenated OPFS `file` to ffmpeg WITHOUT
 * copying it into MEMFS first (unlike the old per-segment `writeFile` + concat-demuxer approach) —
 * halves the memory peak on the input side. ffmpeg reads the mounted file directly as one TS
 * stream, so there's no need for the concat demuxer's file list anymore either (that was only
 * needed when segments were N separate files in ffmpeg's own virtual FS). */
async function remuxToMp4(file: File, sourceUrl: string, status: HTMLElement): Promise<void> {
  postProgress('remux');
  status.textContent = 'Loading ffmpeg.wasm (first run only, ~30MB, bundled with the extension)...';
  const ffmpeg = new FFmpeg();
  await ffmpeg.load({
    // Bundled with the extension (manifest.config.ts's `wasm-unsafe-eval` CSP), not fetched from
    // a CDN — an MV3 extension can't execute remotely-hosted code regardless.
    coreURL: chrome.runtime.getURL(ffmpegCoreUrl.replace(/^\//, '')),
    wasmURL: chrome.runtime.getURL(ffmpegWasmUrl.replace(/^\//, '')),
  });

  status.textContent = 'Mounting segment file into ffmpeg (no copy into its heap)...';
  // Emscripten's FS.mount() requires the mount point to already exist as a directory — WORKERFS
  // doesn't create it implicitly, unlike a plain writeFile() into MEMFS. A fresh `ffmpeg` instance
  // is created per remux attempt (above), so '/input' never already exists here.
  await ffmpeg.createDir('/input');
  await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, '/input');

  try {
    status.textContent = 'Remuxing (TS -> MP4, no re-encode)...';
    const exitCode = await ffmpeg.exec(['-i', `/input/${file.name}`, '-c', 'copy', 'output.mp4']);
    if (exitCode !== 0) throw new Error(`ffmpeg exited with code ${exitCode} — see the browser console for its log.`);

    const output = await ffmpeg.readFile('output.mp4');
    if (typeof output === 'string') throw new Error('ffmpeg returned text instead of the expected binary output.');

    status.textContent = 'Done — starting download.';
    // `output.buffer` can type as `ArrayBufferLike` (possibly SharedArrayBuffer) — copy into a
    // plain ArrayBuffer-backed Uint8Array, which is all `Blob`'s constructor accepts.
    downloadBlob(new Blob([output.slice()], { type: 'video/mp4' }), `${slugify(fileNameFromUrl(sourceUrl), 'stream')}.mp4`);
    postProgress('done');
  } finally {
    await ffmpeg.unmount('/input');
  }
}

/** docs/ROADMAP.md #8.5 — renders the two output choices once all segments are staged in OPFS.
 * Auto-fires ONE of them (no click needed, same automation posture as the rest of this flow,
 * docs/ROADMAP.md #7.6): remux when the file is small enough to safely fit ffmpeg's wasm heap,
 * otherwise the always-safe .ts save — this auto-fallback (not a dead-end error) is what actually
 * unblocks large streams that used to OOM. Both buttons stay available afterward for a manual
 * retry/alternate choice. */
function renderOutputOptions(file: File, sourceUrl: string, status: HTMLElement, actions: HTMLElement): void {
  const underCap = file.size <= REMUX_SIZE_CAP_BYTES;

  const saveTsBtn = button({ type: 'button' }, 'Save (.ts, fast)');
  saveTsBtn.onclick = () => saveTs(file, sourceUrl);

  const remuxBtn = button({ type: 'button', disabled: !underCap }, 'Remux → .mp4');
  const attemptRemux = () => {
    remuxBtn.disabled = true;
    void remuxToMp4(file, sourceUrl, status)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        status.textContent = `Remux failed: ${message}`;
        postProgress('error', undefined, undefined, message);
      })
      .finally(() => {
        remuxBtn.disabled = false;
      });
  };
  remuxBtn.onclick = attemptRemux;

  van.add(
    actions,
    !underCap
      ? p(
          { class: 'merge-error' },
          `File is ${formatBytes(file.size)} — over the ${formatBytes(REMUX_SIZE_CAP_BYTES)} remux limit ` +
            "(ffmpeg.wasm's heap can't safely hold a file this size), so it was saved as .ts directly instead.",
        )
      : null,
    saveTsBtn,
    remuxBtn,
  );

  if (underCap) {
    attemptRemux();
  } else {
    saveTs(file, sourceUrl);
    postProgress('done');
  }
}

async function run(
  manifest: Extract<ParsedManifest, { kind: 'media' }>,
  sourceUrl: string,
  status: HTMLElement,
  startBtn: HTMLButtonElement,
  actions: HTMLElement,
): Promise<void> {
  startBtn.disabled = true;
  // A previous attempt's (Retry's) OPFS file, if any — no resume, retrying starts over, so its
  // partial/finished file is dead weight now.
  if (currentRunId) void removeOpfsRun(currentRunId);
  // Fetch failure mid-run intentionally aborts the whole thing rather than skipping the segment
  // (fetch-images'/crawlSite's per-item skip): a missing image degrades a page, a missing segment
  // breaks video continuity — no partial-result posture makes sense here. No resume — retrying
  // just starts over, same "no half-finished feature" simplicity as everything else in this flow.
  const runId = crypto.randomUUID();
  currentRunId = runId;
  const opfsRun = await createOpfsRun(runId);
  const total = manifest.segments.length;

  // docs/ROADMAP.md #7.4 — replaced WHOLESALE (not spliced by index) once a rotating-signature CDN
  // reissues the manifest: safe under §8.3's concurrent pool because only not-yet-fetched indices
  // ever read `segments` again (already-written ones are done, never re-read).
  let segments = manifest.segments;
  // One refresh attempt for the whole run, not per-segment (a rotating-signature CDN typically
  // rotates the ENTIRE list at once, so one refresh should fix every other still-failing segment
  // too) — a second 401/403 after already spending this budget means something else is wrong, so
  // it's treated as a real failure instead of hammering the manifest endpoint again.
  let refreshBudgetSpent = false;

  async function ensureRefreshed(triggeringIndex: number): Promise<boolean> {
    if (refreshBudgetSpent || manifest.isLive) return false;
    refreshBudgetSpent = true;
    status.textContent = `Segment ${triggeringIndex + 1} link expired — refreshing manifest...`;
    const refreshed = await tryRefreshSegmentsFromIndex(sourceUrl, triggeringIndex);
    if (!refreshed) return false;
    segments = refreshed;
    return true;
  }

  /**
   * docs/ROADMAP.md #8.3 — retries a segment up to 3 times (exponential backoff) before giving up:
   * a transient network blip shouldn't kill a 20-minute download. Still never skip-and-continue past
   * exhausted retries (missing segment = broken video, unlike fetch-images'/crawlSite's per-item
   * skip) — the whole run still aborts once a segment fails every attempt. A 401/403 tries the §7.4
   * manifest refresh once (shared across all segments in this run) and re-reads `segments[index]`
   * fresh on the next attempt rather than counting the refresh itself as a failed attempt.
   *
   * docs/ROADMAP.md #8.4 — a segment carrying a `key` is decrypted here before being handed to the
   * writer. It's never real DRM by this point — `render()`'s upfront scan already refused the whole
   * download if ANY segment's key was — so any key seen here is a plain AES-128 one. IV derivation
   * assumes the manifest's media-sequence numbering doesn't shift across a §7.4 refresh (that
   * recovery is for rotating URL signatures, not a changed segment list, so this holds in practice).
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
          if (await ensureRefreshed(index)) continue; // retry now, doesn't consume a backoff wait
          throw new Error(`Segment ${index + 1} failed: HTTP ${res.status} (link expired, manifest refresh unavailable)`);
        }
        if (!res.ok) throw new Error(`Segment ${index + 1} failed: HTTP ${res.status}`);
        const bytes = await res.arrayBuffer();
        return segment.key ? await decryptSegment(bytes, segment.key, manifest.mediaSequence + index) : bytes;
      } catch (err) {
        lastError = err;
      }
      if (attempt < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 5000)));
    }
    throw lastError instanceof Error ? lastError : new Error(`Segment ${index + 1} failed after ${MAX_ATTEMPTS} attempts.`);
  }

  // docs/ROADMAP.md #8.3 — a pool of concurrent fetches, replacing the old strict-sequential loop.
  // Segments still land in the OPFS file in ORIGINAL order regardless of which fetch finishes first:
  // `pendingWrites` buffers out-of-order arrivals (bounded by the pool size — at most that many
  // fetches are ever in flight at once), `writeChain` serializes the actual OPFS writes one at a
  // time (`opfsRun.write`'s internal offset tracking isn't safe to call concurrently).
  const pendingWrites = new Map<number, ArrayBuffer>();
  let nextToWrite = 0;
  let nextToFetch = 0;
  let cancelled = false;
  let writeChain: Promise<void> = Promise.resolve();

  function enqueueWrite(index: number, bytes: ArrayBuffer): void {
    writeChain = writeChain.then(async () => {
      await opfsRun.write(new Uint8Array(bytes));
      postProgress('segments', index + 1, total);
      status.textContent = `Downloaded segment ${index + 1} / ${total}...`;
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
      if (cancelled) return;
      const index = nextToFetch++;
      if (index >= total) return;
      let bytes: ArrayBuffer;
      try {
        bytes = await fetchSegment(index);
      } catch (err) {
        cancelled = true;
        throw err;
      }
      if (cancelled) return;
      pendingWrites.set(index, bytes);
      flushReady();
    }
  }

  try {
    status.textContent = `Downloading ${total} segment(s) (up to ${SEGMENT_POOL_SIZE} at a time)...`;
    const workerCount = Math.min(SEGMENT_POOL_SIZE, total);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    await writeChain;

    const file = await opfsRun.finish();
    status.textContent = `${total} segment(s) downloaded (${formatBytes(file.size)}).`;
    renderOutputOptions(file, sourceUrl, status, actions);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    status.textContent = `Failed: ${message}`;
    postProgress('error', undefined, undefined, message);
    await writeChain.catch(() => {});
    await opfsRun.abort();
  } finally {
    startBtn.disabled = false;
  }
}

function fileNameFromUrl(url: string): string {
  try {
    const { pathname } = new URL(url);
    const last = pathname.slice(pathname.lastIndexOf('/') + 1).replace(/\.m3u8$/, '');
    return last;
  } catch {
    return '';
  }
}

void load();
