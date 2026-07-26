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
import { describeHeaderReplay, syncHeaderReplayRule } from '../../utils/header-replay-rules';
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

/**
 * Last-resort visibility. This page is opened in the BACKGROUND by the Side Panel (docs/ROADMAP.md
 * #7.6) and its only user-facing channel is `postProgress`, so anything that escapes the normal
 * error paths — a throw during module evaluation, an unhandled rejection in a `void`-ed promise —
 * leaves the Side Panel showing whatever phase it last heard about, forever, with no clue anywhere.
 * Registered before any other work in this module so it also covers failures during that work.
 */
function reportUncaught(what: string, detail: unknown): void {
  const message = detail instanceof Error ? detail.message : String(detail);
  console.error(`Synapse merge: ${what}`, detail);
  const status = document.querySelector('.merge-status');
  if (status) status.textContent = `Failed: ${message}`;
  postProgress('error', undefined, undefined, `${what}: ${message}`);
}
window.addEventListener('unhandledrejection', (event) => reportUncaught('unhandled rejection', event.reason));
window.addEventListener('error', (event) => reportUncaught('uncaught error', event.error ?? event.message));

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
    .then((tab) => (tab?.id !== undefined ? [tab.id] : [chrome.tabs.TAB_ID_NONE]))
    .catch(() => [chrome.tabs.TAB_ID_NONE]);
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
 * docs/ROADMAP.md #7.1 — one-shot diagnostic on the FIRST segment 401/403 of a run.
 *
 * Exists because this failure has many distinct causes that all present identically as a bare 403,
 * and working out which one cost several rounds of manual investigation the first time (the real
 * cause turned out to be the rule's `tabIds` condition never matching this page's fetches, after a
 * long detour into the stream's site-specific `#EXT-X-TOKEN` manifest tag, which was a red herring).
 * Everything needed to tell those causes apart is already in memory here — it just wasn't reported
 * anywhere. So this doesn't merely dump state: it narrows to a single `likelyCause`, since the dump
 * on its own is what was already available via ad-hoc logging.
 *
 * Console-only (plus a pointer in the thrown error's message, since docs/ROADMAP.md #7.6 auto-closes
 * this Tab shortly after an error and the Side Panel only ever shows the message). Never throws —
 * it runs on an error path and must not fail on top of the failure it's explaining.
 */
/** Order-insensitive: `condition.tabIds` comes back from Chrome, not from us, so its ordering is not
 * something to depend on. `undefined` (no tabIds condition at all) never equals an intended list. */
function sameTabIds(live: number[] | undefined, intended: number[]): boolean {
  if (!live || live.length !== intended.length) return false;
  const sortedLive = [...live].sort((a, b) => a - b);
  const sortedIntended = [...intended].sort((a, b) => a - b);
  return sortedLive.every((id, i) => id === sortedIntended[i]);
}

let authDiagnosticLogged = false;
async function logSegmentAuthDiagnostics(url: string, statusCode: number): Promise<void> {
  if (authDiagnosticLogged) return;
  authDiagnosticLogged = true;
  try {
    const host = new URL(url).hostname;
    const replay = await describeHeaderReplay(host);
    const tabIds = await selfTabIds();

    const likelyCause = !replayHeaders
      ? 'No headers were captured for this manifest — no DetectedMedia entry matched it, so NOTHING was ever replayed and the CDN saw a bare extension request. Check that the stream was detected by the webRequest observer (which is what records requestHeaders) rather than only by the DOM/MAIN-world sources.'
      : !replay.intended
        ? `Headers WERE captured (${Object.keys(replayHeaders).join(', ')}) but syncHeaderReplayRule was never called for ${host} — replayHeadersFor() skipped it or threw.`
        : !replay.liveRule
          ? `Rule ${replay.intended.ruleId} was synced for ${host} but is not in the live session ruleset — evicted by MAX_HOSTS, or updateSessionRules failed (check for an earlier console error from header-replay-rules).`
          : !sameTabIds(replay.liveRule.condition.tabIds, replay.intended.tabIds)
            ? `Rule ${replay.intended.ruleId} EXISTS but is not the one this page wrote: its condition.tabIds is [${replay.liveRule.condition.tabIds?.join(', ') ?? 'none'}] where this page asked for [${replay.intended.tabIds.join(', ')}]. Another extension context (background auto-inspect, or another Merge tab) owns that id and overwrote it, so the rule no longer matches this tab's requests.`
            : `Rule ${replay.intended.ruleId} is live, matches this tab, and carries ${replay.intended.headerNames.join(', ')}. So either (a) Chrome overrode a value after the rule applied, which it does for Origin on CORS-mode requests; or (b) this CDN gates on something other than these headers.`;

    console.warn(
      `Synapse: segment fetch got HTTP ${statusCode} — header replay did not satisfy ${host}.\n\nLikely cause: ${likelyCause}`,
      { segmentUrl: url, manifestUrl, capturedHeaders: replayHeaders ?? null, thisPageTabIds: tabIds, ...replay },
    );
  } catch {
    // Diagnostics must never mask the real error the caller is already reporting.
  }
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

/** HLS writes a byte range as `<length>[@<offset>]`; HTTP wants `bytes=<first>-<last>`. A missing
 * `@offset` means "continue from the previous sub-range" per the spec, which for an `#EXT-X-MAP`
 * init segment (the only place this is honored, see ManifestSegment.byteRange) has no previous —
 * so 0 is the only reading available. Returns `undefined` for unparsable input, which the caller
 * treats as "fetch the whole resource" — the same graceful-degradation posture as the parser's
 * per-item skips. */
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

  // Warns rather than blocks on a live playlist: `isLive` is inferred from a MISSING #EXT-X-ENDLIST,
  // and plenty of ordinary VOD playlists omit it by mistake — those download fine today and must keep
  // doing so. The warning exists so that when it does fail partway (see the 404/410 branch in
  // fetchSegment) the reason was already on screen instead of arriving as a bare HTTP error.
  const status = div(
    { class: 'merge-status' },
    manifest.isLive
      ? `${manifest.segments.length} segment(s) found, but this playlist has no #EXT-X-ENDLIST — it looks like a live/sliding-window stream, whose segments expire as it advances. Trying anyway; expect it to stop partway if it really is live.`
      : `${manifest.segments.length} segment(s) found. Starting download...`,
  );
  // docs/ROADMAP.md #7.6 — the button is now only a manual retry after a failure; the normal path
  // runs immediately below, no click needed (the whole point of opening this Tab in the background).
  const startBtn = button({ type: 'button' }, 'Retry');
  const actions = div({ class: 'merge-actions' }, startBtn);
  /**
   * `run()` does real work BEFORE its own try/catch (`createOpfsRun`, which can reject on an OPFS
   * quota/permission failure), and it was invoked as a bare `void run(...)` — so a rejection there
   * became an unhandled promise rejection: no error rendered, no `postProgress('error')` sent, and
   * the status frozen on whatever `render()` last set. That reads as a hang, and it's the worst kind
   * because the failing operation reports nothing at all. Every path out of `run()` must surface.
   */
  const startRun = (): void => {
    void run(manifest, sourceUrl, status, startBtn, actions).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      status.textContent = `Failed before the download could start: ${message}`;
      postProgress('error', undefined, undefined, message);
      startBtn.disabled = false;
    });
  };
  startBtn.onclick = startRun;

  van.add(root, header(h1('Download (merged)'), p(sourceUrl)), status, actions);
  startRun();
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

/** Which container the concatenated OPFS bytes already ARE — decided by whether the manifest
 * carried an `#EXT-X-MAP` init segment, not by preference. Naming fMP4 output `.ts` (as this page
 * did unconditionally before) hands the user a file every player refuses to open. */
type OutputContainer = 'ts' | 'mp4';

/** docs/ROADMAP.md #8.5 — the "no ffmpeg" fast path, and it holds for BOTH containers, for two
 * different reasons: concatenated MPEG-TS segments are playable because TS is self-syncing per
 * 188-byte packet, while concatenated fMP4 is playable because `init + moof/mdat + moof/mdat + ...`
 * is precisely how a fragmented MP4 is laid out to begin with (that's the CMAF wire format, so the
 * concatenation isn't an approximation of a valid file — it IS one, provided `run()` wrote the init
 * segment first). Either way: no wasm, no memory ceiling, works at any size. */
function saveConcatenated(file: File, sourceUrl: string, container: OutputContainer): void {
  downloadBlob(file, `${slugify(fileNameFromUrl(sourceUrl), 'stream')}.${container}`);
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
  // Without this subscription @ffmpeg/ffmpeg prints NOTHING — its worker forwards ffmpeg's stderr
  // as 'log' events and drops them when nobody is listening. The "see the browser console for its
  // log" this function's own error message promises was therefore never true, which is exactly how
  // a failing remux ends up with no diagnosable cause at all.
  ffmpeg.on('log', ({ message }) => console.log(`ffmpeg: ${message}`));
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
 * otherwise the always-safe direct save — this auto-fallback (not a dead-end error) is what actually
 * unblocks large streams that used to OOM. Both buttons stay available afterward for a manual
 * retry/alternate choice. `container` is what the staged bytes already are (see OutputContainer):
 * for an fMP4 stream the direct save is already a `.mp4`, so remux is a cleanup pass (fragmented →
 * plain, faststart) rather than the format conversion it is for MPEG-TS. */
function renderOutputOptions(
  file: File,
  sourceUrl: string,
  status: HTMLElement,
  actions: HTMLElement,
  container: OutputContainer,
): void {
  const underCap = file.size <= REMUX_SIZE_CAP_BYTES;

  const saveDirectBtn = button({ type: 'button' }, `Save (.${container}, fast)`);
  saveDirectBtn.onclick = () => saveConcatenated(file, sourceUrl, container);

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
            `(ffmpeg.wasm's heap can't safely hold a file this size), so it was saved as .${container} directly instead.`,
        )
      : null,
    saveDirectBtn,
    remuxBtn,
  );

  if (underCap) {
    attemptRemux();
  } else {
    saveConcatenated(file, sourceUrl, container);
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
  // Per-run, not per-page: a Retry after a header-replay fix should report again rather than stay
  // silent because the first attempt already used up the one-shot.
  authDiagnosticLogged = false;
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
          // Before the §7.4 expired-link recovery, not after: a 401/403 is ALSO what a failed header
          // replay looks like, and that cause is invisible once the refresh path takes over and
          // reports "link expired" for it.
          await logSegmentAuthDiagnostics(segment.url, res.status);
          if (await ensureRefreshed(index)) continue; // retry now, doesn't consume a backoff wait
          throw new Error(
            `Segment ${index + 1} failed: HTTP ${res.status} — the link expired and no manifest refresh was available, ` +
              "or this CDN's hotlink protection rejected the request. See this tab's console for which of those it was.",
          );
        }
        // docs/ROADMAP.md #7.4 — 404/410 is the OTHER shape an expired segment takes. Where a
        // signature-checking CDN answers 403 for a stale token, a sliding-window one simply stops
        // serving the object once it falls out of the window. Same recovery, same VOD-only guard
        // inside ensureRefreshed; previously this fell through to the generic `!res.ok` throw and
        // never even attempted a refresh.
        if (res.status === 404 || res.status === 410) {
          if (await ensureRefreshed(index)) continue;
          throw new Error(
            manifest.isLive
              ? `Segment ${index + 1} is already gone (HTTP ${res.status}). This playlist carries no #EXT-X-ENDLIST, so it is a live/sliding-window stream: segments expire out of the window as it advances, and there is no fixed set of them to save. This is not a download Synapse can complete.`
              : `Segment ${index + 1} failed: HTTP ${res.status} — that segment URL is no longer served, and refreshing the manifest did not yield a working one.`,
          );
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

  /**
   * The `#EXT-X-MAP` init segment, written as the FIRST bytes of the output file. Fetched inline
   * here rather than through the pool because ordering is not negotiable: on an fMP4/CMAF stream
   * these bytes carry the `ftyp`+`moov` boxes that every following `moof`+`mdat` fragment refers
   * back to, so anything written before them makes the whole file undemuxable. Safe to write
   * directly (bypassing `writeChain`) only because no worker has started at this point.
   */
  async function fetchInitSegment(init: ManifestSegment): Promise<ArrayBuffer> {
    await replayHeadersFor(init.url);
    const range = init.byteRange ? byteRangeToHeader(init.byteRange) : undefined;
    const res = await fetch(init.url, range ? { headers: { Range: range } } : {});
    if (res.status === 401 || res.status === 403) await logSegmentAuthDiagnostics(init.url, res.status);
    if (!res.ok) throw new Error(`Initialization segment failed: HTTP ${res.status} (${init.url})`);
    const bytes = await res.arrayBuffer();
    // Spec-wise an init segment is covered by whatever key is in scope; in practice it precedes any
    // #EXT-X-KEY, so this branch is rarely taken and is untested against a real encrypted-fMP4 stream.
    return init.key ? await decryptSegment(bytes, init.key, manifest.mediaSequence) : bytes;
  }

  try {
    if (manifest.initSegment) {
      status.textContent = 'Downloading initialization segment (fragmented MP4)...';
      await opfsRun.write(new Uint8Array(await fetchInitSegment(manifest.initSegment)));
    }

    status.textContent = `Downloading ${total} segment(s) (up to ${SEGMENT_POOL_SIZE} at a time)...`;
    const workerCount = Math.min(SEGMENT_POOL_SIZE, total);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    await writeChain;

    const file = await opfsRun.finish();
    status.textContent = `${total} segment(s) downloaded (${formatBytes(file.size)}).`;
    // An init segment is what distinguishes fMP4 from MPEG-TS, so it also decides the container the
    // concatenated bytes actually are — see saveConcatenated.
    renderOutputOptions(file, sourceUrl, status, actions, manifest.initSegment ? 'mp4' : 'ts');
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
