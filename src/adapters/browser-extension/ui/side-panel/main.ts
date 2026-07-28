import '@picocss/pico/css/pico.min.css';
import './side-panel.css';
import van from 'vanjs-core';
import { collapseVariantShadowedEntries, listDetectedMedia, type DetectedMedia } from '../../background/modules/network-sniffer/store';
import { DASHBOARD_PATH } from '../dashboard/dashboard-path';
import { REVIEW_PATH } from '../review-path';
import { isReviewData, publishReviewSession, storeReviewFiles, type ReviewPayload } from '../review-handoff';
import { downloadReviewZip } from '../review-zip';
import { listenForActionProgress } from '../action-progress';
import { deleteBlob } from '../../utils/blob-store';
import type { DownloadEngineCommand, DownloadEngineEvent, DownloadEnginePhase, DownloadJobCheckpoint } from '../../../../shared/download-engine-protocol';
import { listDownloadJobCheckpoints } from '../../utils/download-job-checkpoints';
import { describeResolution } from '../../../../shared/resolution-label';
import downloadIconUrl from '../../../../assets/icon/download.svg';

/**
 * network-sniffer's Side Panel (docs/ROADMAP.md §6) — bespoke renderer, not
 * dashboard/views/management-view.ts's generic table: one real video is one list item here, even
 * when its manifest has N resolutions (merged into a single <select>), and there's exactly one
 * Download action per item instead of management-view.ts's separate download/inspect/open-tab
 * rowActions. Scoped to the active tab's EXACT current page (docs/ROADMAP.md §10.4's follow-up,
 * `load()` below) — unlike the Dashboard's Management View, which shows the entire cross-tab
 * detected-media log unfiltered.
 */

const { div, h1, p, span, select, option, button, img, label, input, progress: progressTag } = van.tags;

const root = document.getElementById('root')!;

let items: DetectedMedia[] = [];
// Which variant URL is currently selected per master-playlist entry (entry.id -> variant url) —
// UI-only state, never persisted.
const selectedVariantUrl = new Map<string, string>();

// docs/ROADMAP.md §8.12 — checkpoints for HLS jobs that got no chance to finish before the
// Offscreen Document (and everything it was doing) died — reloaded every `load()`, same cadence as
// `items`, so a checkpoint disappears from here (and the "Resume" row reverts to a normal Download
// button) as soon as the engine clears it — on a successful resume, a failed one, or a fresh
// Download started instead (see `renderItem`: a checkpoint only ever shows up when nothing is
// currently `activeDownloads`-tracked for that entry).
let checkpoints: DownloadJobCheckpoint[] = [];

// docs/ROADMAP.md §7.6/§8.1 — one in-flight download per detected-media entry id (`jobId`), fed by
// `synapse:download-engine-event` broadcasts from the singleton Offscreen Document's engine
// (handleDownload below sends the START command that kicks it off). UI-only, never persisted:
// reloading the Side Panel just loses the progress display, the engine keeps running regardless
// (same "no persistence" posture §7.6 already accepted, now also covering Pause/Cancel state).
interface DownloadProgress {
  phase: DownloadEnginePhase;
  done?: number | undefined;
  total?: number | undefined;
  message?: string | undefined;
  bytesPerSec?: number | undefined;
  etaMs?: number | undefined;
  /** Which resolution/variant this particular job is downloading — captured once at click time
   * (`handleDownload`) since `selectedVariantUrl` can change afterward (the picker stays interactive
   * during a download) without affecting the job already in flight. Shown alongside progress so a
   * user with several resolutions available isn't left guessing which one is actually downloading. */
  resolutionLabel?: string | undefined;
}
const activeDownloads = new Map<string, DownloadProgress>();
// Gives the 'done'/'error'/'cancelled' state a moment on screen before this row's progress UI
// disappears — long enough to read "Done"/"Failed: ..."/"Cancelled", short enough not to feel stuck.
const DOWNLOAD_SETTLE_DELAY_MS = 1500;

function sendEngineCommand(
  op: DownloadEngineCommand['op'],
  jobId: string,
  url?: string,
  extra?: { resolutionLabel?: string | undefined; checkpoint?: DownloadJobCheckpoint | undefined },
): void {
  const command: DownloadEngineCommand = { type: 'synapse:download-engine-command', op, jobId, url, ...extra };
  void chrome.runtime.sendMessage(command).catch(() => {});
}

/**
 * Bugfix: every state change used to call `render()` directly, which does a full
 * `root.replaceChildren()` + rebuild of the ENTIRE list (every item, not just the one that
 * changed) — VanJS has no fine-grained DOM diffing here, this is a from-scratch teardown/rebuild
 * every time. That's fine for occasional triggers (a click, a `chrome.storage` change), but the
 * `synapse:download-engine-event` listener below can fire many times per SECOND while a stream with
 * hundreds of segments is downloading — rebuilding every button in the whole panel that often is
 * what actually caused the reported flicker AND missed clicks (a click can land on a node that's
 * mid-teardown from the NEXT rebuild firing before the browser even finished painting the last one).
 * `scheduleRender` coalesces any number of render requests within one animation frame into a single
 * `render()` call — caps the rebuild rate at the display's own repaint rate, which is both
 * imperceptible for a single click and enough to eliminate the flicker under a rapid event burst.
 */
let renderScheduled = false;
function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

// docs/ROADMAP.md §8.2 — opt-in "Turbo download" (off by default, per the roadmap's own explicit
// design: a hand-rolled N-connection downloader gives up chrome.downloads' free resume/no-RAM-cost/
// download-shelf visibility, so it must never be silently forced on). A single header-level toggle,
// not a per-item button — reads more naturally as a mode than a second button on every row.
// Persisted per the "each module owns its own storage" convention, namespaced under network-sniffer
// even though this is a UI preference, not `DetectedMedia` collection data.
const TURBO_STORAGE_KEY = 'network-sniffer:turboDownloadsEnabled';
let turboEnabled = false;
void chrome.storage.local.get(TURBO_STORAGE_KEY).then((result) => {
  turboEnabled = result[TURBO_STORAGE_KEY] === true;
  scheduleRender();
});

async function activeTabUrl(): Promise<string | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url;
}

async function load(): Promise<void> {
  const tabUrl = await activeTabUrl();
  const all = await listDetectedMedia();
  checkpoints = await listDownloadJobCheckpoints();
  // Scoped to the EXACT current page (docs/ROADMAP.md §10.4's follow-up) — was origin-only before,
  // which meant every video ever detected anywhere on a site accumulated into one list the moment
  // you looked at ANY page on that site, regardless of whether you'd navigated away from the page
  // that actually had it (reported as "messy, hard to use"). Exact-URL match fixes that at the cost
  // of hiding an entry across an SPA route change that updates the address bar without a real
  // navigation — accepted tradeoff, matching the browser's own `chrome.tabs.query` url (which DOES
  // track pushState/history navigation, so this isn't as narrow as "hard reload only").
  //
  // Prefers `tabUrl` (the TAB's own top-level url at detection time) over `pageUrl` (the INITIATING
  // FRAME's url) — they differ exactly when a cross-origin iframe loads the media (an embedded
  // player, or an ad frame), and comparing `pageUrl` there asks "was this served by the exact frame
  // you're looking at?", which is not the question. `pageUrl` stays as the fallback only for
  // entries recorded before `tabUrl` existed (docs/ROADMAP.md §10.4 added it to every detection
  // source, not just `webRequest`).
  items = tabUrl ? collapseVariantShadowedEntries(all.filter((m) => (m.tabUrl ?? m.pageUrl) === tabUrl)) : [];
  scheduleRender();
}

function resolveDownloadUrl(item: DetectedMedia): string {
  return selectedVariantUrl.get(item.id) ?? item.variants?.[0]?.url ?? item.url;
}

/** Same label shown in the resolution `<select>` (see `renderItem`'s `variantSelect`), resolved for
 * whichever variant `url` actually is — used to stamp a download's progress row with the resolution
 * it's actually fetching, since the picker itself stays interactive (and so can change) while a
 * download for a PREVIOUS selection is still running. */
function variantLabelForUrl(item: DetectedMedia, url: string): string | undefined {
  if (item.variants && item.variants.length > 0) {
    const index = item.variants.findIndex((v) => v.url === url);
    const variant = index >= 0 ? item.variants[index] : item.variants[0];
    return describeResolution(variant?.resolution, `Variant ${(index >= 0 ? index : 0) + 1}`);
  }
  return item.resolution;
}

function handleDownload(item: DetectedMedia): void {
  if (item.kind === 'stream') {
    if (activeDownloads.has(item.id)) return; // already downloading this entry
    // DRM guard (`encrypted`) is enforced by the engine itself once it re-fetches+parses the
    // manifest — not duplicated here (docs/ROADMAP.md §6.3).
    const url = resolveDownloadUrl(item);
    // docs/ROADMAP.md §8.1 — no Tab opens anymore: this just starts a job in the singleton
    // Offscreen Document (background/index.ts ensures it exists before forwarding the command).
    // `jobId` is this entry's own id, same convention the old `entryId` used.
    activeDownloads.set(item.id, { phase: 'segments', resolutionLabel: variantLabelForUrl(item, url) });
    scheduleRender();
    sendEngineCommand('START', item.id, url, { resolutionLabel: variantLabelForUrl(item, url) });
    return;
  }
  // docs/ROADMAP.md §8.2 — Turbo toggle only affects this branch (`kind:'video'|'audio'`); `'stream'`
  // above already never used chrome.downloads. Same optimistic-progress-row pattern as the stream
  // branch: the engine itself silently falls back to chrome.downloads (with an explanatory `message`
  // on its 'done' event) if the server doesn't support ranged requests, so this is never a dead end.
  if (turboEnabled) {
    if (activeDownloads.has(item.id)) return;
    activeDownloads.set(item.id, { phase: 'chunks', resolutionLabel: variantLabelForUrl(item, item.url) });
    scheduleRender();
    sendEngineCommand('START_TURBO', item.id, item.url);
    return;
  }
  void chrome.downloads.download({ url: item.url });
}

/** docs/ROADMAP.md §8.12 — continues an HLS job that never reached a terminal state before this
 * extension's Offscreen Document died (browser crash/close, manual reload mid-download) — never
 * triggered automatically, only by the user clicking the "Resume" row `renderItem` shows in place
 * of the normal Download button whenever a checkpoint exists for this entry. The engine itself
 * re-validates the checkpoint against the real state of the manifest and the partial file on disk
 * before trusting it (utils/download-engine.ts's `resumeJobFromCheckpoint`) — a failed resume just
 * reports an error and clears the checkpoint, same terminal-phase handling as any other job. */
function handleResume(item: DetectedMedia, checkpoint: DownloadJobCheckpoint): void {
  if (activeDownloads.has(item.id)) return;
  activeDownloads.set(item.id, {
    phase: 'segments',
    resolutionLabel: checkpoint.resolutionLabel,
    done: checkpoint.lastConfirmedSegmentIndex + 1,
    total: checkpoint.total,
  });
  scheduleRender();
  sendEngineCommand('RESUME_CHECKPOINT', item.id, undefined, { checkpoint });
}

/** docs/ROADMAP.md §7.6/§8.1 — settles the row back to normal after a 'done'/'error'/'cancelled'
 * phase: clears the progress state so the Download button comes back. No Tab to close anymore — the
 * engine's own job entry is already gone by the time it emits one of these terminal phases. */
function settleDownload(entryId: string): void {
  setTimeout(() => {
    activeDownloads.delete(entryId);
    scheduleRender();
  }, DOWNLOAD_SETTLE_DELAY_MS);
}

chrome.runtime.onMessage.addListener((message: Partial<DownloadEngineEvent> & { type?: string } | undefined) => {
  if (message?.type !== 'synapse:download-engine-event' || !message.jobId || !message.phase) return;
  const existing = activeDownloads.get(message.jobId);
  activeDownloads.set(message.jobId, {
    ...existing,
    phase: message.phase,
    done: message.segmentsDone,
    total: message.segmentsTotal,
    message: message.message,
    bytesPerSec: message.bytesPerSec,
    etaMs: message.etaMs,
  });
  scheduleRender();
  if (message.phase === 'done' || message.phase === 'error' || message.phase === 'cancelled') settleDownload(message.jobId);
});

// docs/ROADMAP.md §9.1 — Reader Mode Converter's in-page Convert/Crawl icons (content-scripts/
// index.ts) run in-process and stream their progress/result here rather than to a Popup (which
// would be destroyed on lost focus mid-crawl) or straight to a new Tab (which would hijack the
// user's browsing before there's anything to show). UI-only, never persisted — same trade-off
// `activeDownloads` above already accepts: resets on panel close/reopen, but the content-script
// job itself is unaffected, only its progress display here.
type ReaderModeJob =
  | { status: 'running'; message: string; done?: number; total?: number }
  | { status: 'done'; reviewId: string; payload: ReviewPayload }
  | { status: 'error'; message: string };
let readerModeJob: ReaderModeJob | undefined;

listenForActionProgress((progress) => {
  readerModeJob = { status: 'running', message: progress.message, done: progress.done, total: progress.total };
  scheduleRender();
});

/** Stores the result's images (`storeReviewFiles` — this Side Panel is a full extension page, so
 * unlike the content script that produced this result, it has IndexedDB access) so "Download ZIP"
 * and "Open in new tab" both have `blobRef`s ready immediately, without re-fetching anything. */
async function handleReaderModeResult(data: unknown): Promise<void> {
  if (!isReviewData(data)) {
    readerModeJob = { status: 'error', message: "This module's result is not in the expected {title, pages, files} shape." };
    scheduleRender();
    return;
  }
  // A previous job's blobs are only reachable through readerModeJob itself (no Review tab may
  // ever have opened for it) — clear them before overwriting so they don't orphan.
  if (readerModeJob?.status === 'done') {
    for (const ref of readerModeJob.payload.fileRefs) void deleteBlob(ref.blobRef);
  }
  const reviewId = crypto.randomUUID();
  const fileRefs = await storeReviewFiles(reviewId, data.files);
  readerModeJob = { status: 'done', reviewId, payload: { title: data.title, pages: data.pages, fileRefs } };
  scheduleRender();
}

chrome.runtime.onMessage.addListener((message: { type?: string; data?: unknown; message?: string } | undefined) => {
  if (message?.type === 'synapse:reader-mode-result') {
    void handleReaderModeResult(message.data);
  } else if (message?.type === 'synapse:reader-mode-error') {
    readerModeJob = { status: 'error', message: message.message ?? 'Unknown error' };
    scheduleRender();
  }
});

function handleReaderModeOpenTab(reviewId: string, payload: ReviewPayload): void {
  // Reuses the SAME reviewId storeReviewFiles already minted above, so the blobs already stored
  // for it stay valid — no re-storing needed.
  void publishReviewSession(reviewId, payload).then(() => {
    void chrome.tabs.create({ url: `${chrome.runtime.getURL(REVIEW_PATH)}?reviewId=${encodeURIComponent(reviewId)}` });
  });
}

/** Shared by both sections so the two features read as clearly distinct parts of one panel
 * instead of blending into a single list (docs/ROADMAP.md §9.1). */
function renderSectionHeader(icon: string, title: string) {
  return div({ class: 'panel-section-header' }, span({ class: 'panel-section-icon' }, icon), span(title));
}

function renderReaderModeSection() {
  if (!readerModeJob) return null;

  if (readerModeJob.status === 'running') {
    // Real fill (not a plain indeterminate spinner) once done/total are known — crawlSite's
    // pings always carry both; a single-page Convert never pings at all (fast enough this state
    // is skipped entirely), so `total` stays undefined only in a window that's effectively never
    // seen on screen.
    const { done, total } = readerModeJob;
    return div(
      { class: 'reader-mode-section' },
      renderSectionHeader('📄', 'Reader Mode'),
      div(
        { class: 'media-item-progress' },
        total ? progressTag({ value: done ?? 0, max: total }) : progressTag(),
        span({ class: 'download-progress-text' }, readerModeJob.message),
      ),
    );
  }

  if (readerModeJob.status === 'error') {
    return div(
      { class: 'reader-mode-section' },
      renderSectionHeader('📄', 'Reader Mode'),
      span({ class: 'download-progress-text download-progress-error' }, `Failed: ${readerModeJob.message}`),
    );
  }

  const { payload, reviewId } = readerModeJob;
  return div(
    { class: 'reader-mode-section' },
    renderSectionHeader('📄', 'Reader Mode'),
    p({ class: 'media-item-summary' }, `${payload.title} — ${payload.pages.length} page${payload.pages.length === 1 ? '' : 's'}`),
    div(
      { class: 'reader-mode-actions' },
      button({ class: 'secondary', onclick: () => void downloadReviewZip(payload, true) }, 'Download ZIP'),
      button({ onclick: () => handleReaderModeOpenTab(reviewId, payload) }, 'Open in new tab'),
    ),
  );
}

function openDashboard(): void {
  void chrome.tabs.create({ url: `${chrome.runtime.getURL(DASHBOARD_PATH)}?moduleId=network-sniffer` });
}

/** Last path segment as a readable stand-in for the full URL (which is often a long opaque hash) —
 * falls back to the full URL itself when the path has nothing usable (e.g. just `/`). */
function fileNameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split('/').filter(Boolean).pop();
    return last ?? url;
  } catch {
    return url;
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function resolutionSummary(item: DetectedMedia): string | undefined {
  if (item.variants && item.variants.length > 0) return `${item.variants.length} resolutions available`;
  if (item.resolution) return item.resolution;
  if (item.segmentCount !== undefined) return `${item.segmentCount} segments`;
  return undefined;
}

/** "~2m left" / "~45s left" — always prefixed with "~" (docs/ROADMAP.md §8.1: `etaMs` is an
 * estimate from this job's own observed throughput, never a precise countdown). */
function formatEta(etaMs: number): string {
  const totalSeconds = Math.round(etaMs / 1000);
  if (totalSeconds < 60) return `~${totalSeconds}s left`;
  const minutes = Math.round(totalSeconds / 60);
  return `~${minutes}m left`;
}

/** docs/ROADMAP.md §7.6/§8.1 — replaces the Download button while a `kind:'stream'` entry's engine
 * job is running, so the row shows what's happening instead of looking clickable-but-inert.
 * `'segments'`'s `total` is only known once the engine has fetched+parsed the manifest itself, so it
 * renders a bare "Starting…" line until the first per-segment event arrives. */
function renderDownloadProgress(state: DownloadProgress) {
  if (state.phase === 'error') {
    return span({ class: 'download-progress-text download-progress-error' }, `Failed: ${state.message ?? 'unknown error'}`);
  }
  if (state.phase === 'cancelled') {
    return span({ class: 'download-progress-text' }, 'Cancelled');
  }
  if (state.phase === 'done') {
    // docs/ROADMAP.md §8.2 — turbo's silent-fallback-to-chrome.downloads case rides the same 'done'
    // phase but carries an explanatory `message` instead of the usual bare "Done".
    return span({ class: 'download-progress-text' }, state.message ?? 'Done');
  }
  if (state.phase === 'remux') {
    return span({ class: 'download-progress-text' }, 'Remuxing...');
  }
  // 'segments' (HLS) and 'chunks' (§8.2 turbo) render identically — both are just "N of M pieces
  // done" with the same done/total/bytesPerSec/etaMs shape (shared/download-engine-protocol.ts).
  const total = state.total;
  const partText = total ? `Part ${state.done ?? 0}/${total}` : 'Starting...';
  const etaText = state.etaMs !== undefined ? ` (${formatEta(state.etaMs)})` : '';
  // 'pausing' — bugfix: PAUSE only stops NEW claims, so whatever was already in flight (up to one
  // per worker/chunk) is still genuinely finishing. Showing "Paused" at this point was a lie the
  // engine couldn't back up — those still-arriving pieces kept nudging `total`/`done` forward
  // underneath it. The engine now only emits the real `'paused'` phase once everything has settled.
  const statusPrefix = state.phase === 'paused' ? 'Paused — ' : state.phase === 'pausing' ? 'Pausing… ' : '';
  return div(
    { class: 'download-progress' },
    total ? progressTag({ value: state.done ?? 0, max: total }) : progressTag(),
    span({ class: 'download-progress-text' }, statusPrefix ? `${statusPrefix}${partText}` : `${partText}${etaText}`),
  );
}

function renderItem(item: DetectedMedia) {
  // Bug fixed: `selected` used to be hardcoded to `i === 0` — every re-render (which happens on
  // EVERY progress event while a download is running, not just on click) rebuilt this <select> from
  // scratch and always marked the FIRST option selected in the DOM, even though `selectedVariantUrl`
  // still remembered the user's real choice underneath. Deriving `selected` from the same
  // `resolveDownloadUrl(item)` the Download button itself reads keeps the visible selection in sync
  // with actual state across every re-render, not just the first one.
  const currentUrl = resolveDownloadUrl(item);
  const variantSelect =
    item.variants && item.variants.length > 0
      ? select(
          {
            onchange: (e: Event) => selectedVariantUrl.set(item.id, (e.target as HTMLSelectElement).value),
          },
          ...item.variants.map((v, i) => option({ value: v.url, selected: v.url === currentUrl }, describeResolution(v.resolution, `Variant ${i + 1}`))),
        )
      : null;
  const summary = resolutionSummary(item);
  const downloadProgress = activeDownloads.get(item.id);
  // docs/ROADMAP.md §8.12 — only ever relevant for a stream with no download already running for
  // it; `downloadProgress` (checked first below) always wins once a Resume/Download click has fired.
  const checkpoint = !downloadProgress && item.kind === 'stream' ? checkpoints.find((c) => c.jobId === item.id) : undefined;

  return div(
    { class: 'media-item' },
    div(
      { class: 'media-item-badges' },
      span({ class: 'kind-badge' }, item.kind),
      item.encrypted ? span({ class: 'drm-badge' }, 'DRM') : null,
      // docs/ROADMAP.md #7.4 — a label, not a filter (see DetectedMedia.expiring's doc comment) —
      // just a nudge to download before a signed/time-limited link rots.
      item.expiring ? span({ class: 'expiring-badge', title: 'This link looks signed/time-limited' }, 'Expires soon') : null,
    ),
    p({ class: 'media-item-filename', title: item.url }, fileNameFromUrl(item.url)),
    item.pageUrl ? p({ class: 'media-item-source' }, `Found on ${hostnameOf(item.pageUrl)}`) : null,
    summary ? p({ class: 'media-item-summary' }, summary) : null,
    div(
      { class: 'media-item-actions' },
      variantSelect,
      downloadProgress
        ? null
        : checkpoint
          ? button({ class: 'resume-btn secondary', title: 'Resume download', onclick: () => handleResume(item, checkpoint) }, 'Resume')
          : button(
              { class: 'download-btn', title: 'Download', 'aria-label': 'Download', onclick: () => handleDownload(item) },
              img({ src: downloadIconUrl, alt: '' }),
            ),
    ),
    // Which resolution is actually downloading — shown once a job is running so a video with
    // several resolutions doesn't leave the user guessing (reuses .media-item-summary's styling,
    // same "small muted line" treatment as the segment-count/resolution summary above).
    downloadProgress?.resolutionLabel ? p({ class: 'media-item-summary' }, `Downloading: ${downloadProgress.resolutionLabel}`) : null,
    // docs/ROADMAP.md §8.12 — surfaces WHY a "Resume" button showed up instead of the usual
    // Download one: this entry has a partially-downloaded file sitting in OPFS from an interrupted
    // session (browser crash/close, extension reload mid-download), not just a plain unstarted item.
    checkpoint
      ? p({ class: 'media-item-summary' }, `Interrupted at ${checkpoint.lastConfirmedSegmentIndex + 1}/${checkpoint.total} segments${checkpoint.resolutionLabel ? ` (${checkpoint.resolutionLabel})` : ''} — resume to continue.`)
      : null,
    // Own full-width row, not sharing .media-item-actions with the resolution <select> — a
    // <progress> bar/status line squeezed into that row's remaining space (next to the select) was
    // cramped and easy to miss.
    downloadProgress
      ? div(
          { class: 'media-item-progress' },
          renderDownloadProgress(downloadProgress),
          // docs/ROADMAP.md §8.1/§8.2 — Pause/Resume/Cancel only make sense while the segment/chunk
          // pool is actually running, pausing, or fully paused; the engine has no cancellation
          // checkpoint during 'remux' (ffmpeg has already started, HLS-only), and the terminal phases
          // are about to settle away on their own.
          downloadProgress.phase === 'segments' ||
          downloadProgress.phase === 'chunks' ||
          downloadProgress.phase === 'pausing' ||
          downloadProgress.phase === 'paused'
            ? div(
                { class: 'download-controls' },
                // 'pausing' — the PAUSE command was already sent; showing an active Pause/Resume
                // toggle here would let a click send ANOTHER command (PAUSE again is a no-op, but
                // RESUME on a job that hasn't actually stopped yet is confusing) before the engine has
                // even reported it settled. Disabled and inert until the real 'paused' phase arrives.
                downloadProgress.phase === 'pausing'
                  ? button({ class: 'secondary', disabled: true, title: 'Pausing…', 'aria-label': 'Pausing' }, '⏸')
                  : button(
                      {
                        class: 'secondary',
                        title: downloadProgress.phase === 'paused' ? 'Resume' : 'Pause',
                        'aria-label': downloadProgress.phase === 'paused' ? 'Resume' : 'Pause',
                        onclick: () => sendEngineCommand(downloadProgress.phase === 'paused' ? 'RESUME' : 'PAUSE', item.id),
                      },
                      downloadProgress.phase === 'paused' ? '▶' : '⏸',
                    ),
                button(
                  { class: 'secondary', title: 'Cancel', 'aria-label': 'Cancel', onclick: () => sendEngineCommand('CANCEL', item.id) },
                  '✕',
                ),
              )
            : null,
        )
      : null,
  );
}

function toggleTurbo(e: Event): void {
  turboEnabled = (e.target as HTMLInputElement).checked;
  void chrome.storage.local.set({ [TURBO_STORAGE_KEY]: turboEnabled });
}

function render(): void {
  root.replaceChildren();
  van.add(
    root,
    div(
      { class: 'panel-header' },
      h1('Synapse'),
      button({ class: 'secondary', title: 'Media Sniffer settings', onclick: openDashboard }, '⚙'),
    ),
    renderReaderModeSection(),
    // docs/ROADMAP.md §9.1 — its own labeled section, same as Reader Mode above, now that this
    // panel hosts more than one module's content — the two shouldn't read as one blended list.
    renderSectionHeader('🎬', 'Media Sniffer'),
    // docs/ROADMAP.md §8.2 — off by default; only affects the video/audio Download branch (streams
    // never used chrome.downloads to begin with).
    label(
      { class: 'turbo-toggle', title: 'Multi-connection downloader for direct video/audio files — off by default; only helps on servers that throttle per connection.' },
      input({ type: 'checkbox', checked: turboEnabled, onchange: toggleTurbo }),
      ' ⚡ Turbo downloads',
    ),
    items.length === 0 ? p('No media detected on this page yet.') : div({ class: 'media-list' }, ...items.map(renderItem)),
  );
}

// Reactive refresh — new detections write to chrome.storage.local (same pattern as
// dashboard/main.ts), and the Side Panel is per-window (not per-tab), so it also needs to refresh
// when the active tab changes within its window (docs/ROADMAP.md §6.4's noted risk/behavior to
// verify by hand).
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') void load();
});
chrome.tabs.onActivated.addListener(() => void load());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url) void load();
});

void load();
