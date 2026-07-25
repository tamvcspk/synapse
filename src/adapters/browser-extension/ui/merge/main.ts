import van from 'vanjs-core';
import '@picocss/pico/css/pico.min.css';
import './merge.css';
import { FFmpeg } from '@ffmpeg/ffmpeg';
// `?url` (plain Vite feature, not crx's `?script&iife`) — these two are fetched by the ffmpeg.wasm
// worker itself (via `import()`/`fetch()`) only once `ffmpeg.load()` actually runs, not eagerly at
// page load, even though the import sits at module top level; the string is just a URL.
import ffmpegCoreUrl from '@ffmpeg/core?url';
import ffmpegWasmUrl from '@ffmpeg/core/wasm?url';
import { parseM3u8, type ParsedManifest } from '../../../../shared/media-manifest-parser';
import { slugify } from '../../../../shared/slugify';
import { deleteBlob, getBlob, putBlob } from '../../utils/blob-store';
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

// Same courteous pacing as crawlSite (docs/ROADMAP.md #1) — this is still one browser hitting one
// server hundreds of times in a row.
const SEGMENT_DELAY_MS = 200;

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
  await syncHeaderReplayRule(host, replayHeaders);
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

  // Mandatory guard, not optional (docs/ROADMAP.md #5.3) — feeding an encrypted (Widevine/EME)
  // segment into ffmpeg.wasm's `-c copy` doesn't fail loudly, it produces a silently-corrupt file.
  if (manifest.encrypted) {
    const message = 'This stream is DRM-protected — its manifest declares an EXT-X-KEY method other than NONE.';
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
  startBtn.onclick = () => void run(manifest, sourceUrl, status, startBtn);

  van.add(root, header(h1('Download (merged)'), p(sourceUrl)), status, div({ class: 'merge-actions' }, startBtn));
  void run(manifest, sourceUrl, status, startBtn);
}

/**
 * docs/ROADMAP.md #7.4 — a segment 401/403 mid-run usually means its signed URL expired, not that
 * the video vanished: refetching the SAME manifest almost always reissues the whole segment list
 * with fresh signatures. Remaps by INDEX (not by matching old URLs) since that's the only stable key
 * across two fetches of a rotating-signature playlist. Only ever attempted once per run (`budget`,
 * mutated by the caller) and only when the manifest is confirmed VOD (`!isLive`, media-manifest-
 * parser.ts's `isLive`) — a live playlist's segment window slides, so index i doesn't name the same
 * segment in a re-fetch. Returns `undefined` on any failure to refetch/reparse, or when the refreshed
 * manifest can't be trusted for a remap (still live, or too short to have an entry at `fromIndex`) —
 * the caller treats that the same as the original failure and aborts.
 */
async function tryRefreshSegmentsFromIndex(
  manifestUrl: string,
  fromIndex: number,
): Promise<string[] | undefined> {
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

async function run(
  manifest: Extract<ParsedManifest, { kind: 'media' }>,
  sourceUrl: string,
  status: HTMLElement,
  startBtn: HTMLButtonElement,
): Promise<void> {
  startBtn.disabled = true;
  // Fetch failure mid-run intentionally aborts the whole thing rather than skipping the segment
  // (fetch-images'/crawlSite's per-item skip): a missing image degrades a page, a missing segment
  // breaks video continuity — no partial-result posture makes sense here. No resume — retrying
  // just starts over, same "no half-finished feature" simplicity as everything else in this flow.
  const runId = crypto.randomUUID();
  const blobRefs: string[] = [];
  // Mutable working copy — docs/ROADMAP.md #7.4's recovery replaces the still-unfetched tail (indices
  // >= i) in place with a freshly re-signed list, without touching what's already been downloaded.
  let segments = manifest.segments;
  // One refresh attempt for the whole run, not per-segment (a rotating-signature CDN typically
  // rotates the ENTIRE remaining list at once, so one refresh should fix every later segment too) —
  // a second 401/403 after already spending this budget means something else is wrong, so it aborts
  // instead of hammering the manifest endpoint again.
  let refreshBudgetSpent = false;

  try {
    for (let i = 0; i < segments.length; i++) {
      status.textContent = `Downloading segment ${i + 1} / ${segments.length}...`;
      await replayHeadersFor(segments[i]!);
      let res = await fetch(segments[i]!);
      if ((res.status === 401 || res.status === 403) && !refreshBudgetSpent && !manifest.isLive) {
        refreshBudgetSpent = true;
        status.textContent = `Segment ${i + 1} link expired — refreshing manifest...`;
        const refreshed = await tryRefreshSegmentsFromIndex(sourceUrl, i);
        if (refreshed) {
          segments = [...segments.slice(0, i), ...refreshed.slice(i)];
          await replayHeadersFor(segments[i]!);
          res = await fetch(segments[i]!);
        }
      }
      if (!res.ok) throw new Error(`Segment ${i + 1} failed: HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      const blobRef = `merge:${runId}:${i}`;
      // Temp storage in IndexedDB (blob-store.ts), not held in one big JS array — segments can
      // number in the hundreds, and each is only needed again once, sequentially, at remux time.
      await putBlob(blobRef, { mimeType: 'video/mp2t', fileName: `seg${i}.ts`, bytes });
      blobRefs.push(blobRef);
      // Posted as "i+1 done" (segment just saved), not "i" (segment about to start) — reaches
      // N/N right before the 'remux' phase instead of stalling one short of it.
      postProgress('segments', i + 1, segments.length);
      if (i < segments.length - 1) await new Promise((resolve) => setTimeout(resolve, SEGMENT_DELAY_MS));
    }

    postProgress('remux');
    status.textContent = 'Loading ffmpeg.wasm (first run only, ~30MB, bundled with the extension)...';
    const ffmpeg = new FFmpeg();
    await ffmpeg.load({
      // Bundled with the extension (manifest.config.ts's `wasm-unsafe-eval` CSP), not fetched from
      // a CDN — an MV3 extension can't execute remotely-hosted code regardless.
      coreURL: chrome.runtime.getURL(ffmpegCoreUrl.replace(/^\//, '')),
      wasmURL: chrome.runtime.getURL(ffmpegWasmUrl.replace(/^\//, '')),
    });

    status.textContent = 'Writing segments into ffmpeg...';
    for (let i = 0; i < blobRefs.length; i++) {
      const blob = await getBlob(blobRefs[i]!);
      if (!blob) throw new Error(`Segment ${i} went missing before remux — try again.`);
      await ffmpeg.writeFile(`seg${i}.ts`, new Uint8Array(blob.bytes));
      // Freed as soon as ffmpeg's own virtual FS has its copy, not held until the whole run ends.
      void deleteBlob(blobRefs[i]!);
    }
    // Concat demuxer over a file list, not raw byte concatenation — works for any well-formed
    // MPEG-TS segment set (the codepath this scope is limited to, see media-manifest-parser.ts),
    // without needing to hold every segment's bytes in one JS buffer at once.
    const listText = blobRefs.map((_, i) => `file 'seg${i}.ts'`).join('\n');
    await ffmpeg.writeFile('list.txt', new TextEncoder().encode(listText));

    status.textContent = 'Remuxing (TS -> MP4, no re-encode)...';
    const exitCode = await ffmpeg.exec(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'output.mp4']);
    if (exitCode !== 0) throw new Error(`ffmpeg exited with code ${exitCode} — see the browser console for its log.`);

    const output = await ffmpeg.readFile('output.mp4');
    if (typeof output === 'string') throw new Error('ffmpeg returned text instead of the expected binary output.');

    status.textContent = 'Done — starting download.';
    // `output.buffer` can type as `ArrayBufferLike` (possibly SharedArrayBuffer) — copy into a
    // plain ArrayBuffer-backed Uint8Array, which is all `Blob`'s constructor accepts.
    const blobUrl = URL.createObjectURL(new Blob([output.slice()], { type: 'video/mp4' }));
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = `${slugify(fileNameFromUrl(sourceUrl), 'stream')}.mp4`;
    anchor.click();
    URL.revokeObjectURL(blobUrl);
    postProgress('done');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    status.textContent = `Failed: ${message}`;
    postProgress('error', undefined, undefined, message);
  } finally {
    for (const ref of blobRefs) void deleteBlob(ref);
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
