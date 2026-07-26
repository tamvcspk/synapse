import '@picocss/pico/css/pico.min.css';
import './side-panel.css';
import van from 'vanjs-core';
import { collapseVariantShadowedEntries, listDetectedMedia, type DetectedMedia } from '../../background/modules/network-sniffer/store';
import { DASHBOARD_PATH } from '../dashboard/dashboard-path';
import type { DownloadEngineCommand, DownloadEngineEvent, DownloadEnginePhase } from '../../../../shared/download-engine-protocol';
import downloadIconUrl from '../../../../assets/icon/download.svg';

/**
 * network-sniffer's Side Panel (docs/ROADMAP.md §6) — bespoke renderer, not
 * dashboard/views/management-view.ts's generic table: one real video is one list item here, even
 * when its manifest has N resolutions (merged into a single <select>), and there's exactly one
 * Download action per item instead of management-view.ts's separate download/inspect/open-tab
 * rowActions. Scoped to the active tab's origin — unlike the Dashboard's Management View, which
 * shows the entire cross-tab detected-media log unfiltered.
 */

const { div, h1, p, span, select, option, button, img, progress: progressTag } = van.tags;

const root = document.getElementById('root')!;

let items: DetectedMedia[] = [];
// Which variant URL is currently selected per master-playlist entry (entry.id -> variant url) —
// UI-only state, never persisted.
const selectedVariantUrl = new Map<string, string>();

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
}
const activeDownloads = new Map<string, DownloadProgress>();
// Gives the 'done'/'error'/'cancelled' state a moment on screen before this row's progress UI
// disappears — long enough to read "Done"/"Failed: ..."/"Cancelled", short enough not to feel stuck.
const DOWNLOAD_SETTLE_DELAY_MS = 1500;

function sendEngineCommand(op: DownloadEngineCommand['op'], jobId: string, url?: string): void {
  const command: DownloadEngineCommand = { type: 'synapse:download-engine-command', op, jobId, url };
  void chrome.runtime.sendMessage(command).catch(() => {});
}

async function activeTabOrigin(): Promise<string | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return undefined;
  try {
    return new URL(tab.url).origin;
  } catch {
    return undefined;
  }
}

async function load(): Promise<void> {
  const origin = await activeTabOrigin();
  const all = await listDetectedMedia();
  // Scoping prefers `tabUrl` (the TAB's own top-level url) over `pageUrl` (the INITIATING FRAME's
  // origin). They differ exactly when a cross-origin iframe loads the media — an embedded player, or
  // an ad frame — and comparing `pageUrl` there asks "was this served by the site you're looking
  // at?", which is not the question. The answer was `false` for every such entry, so the Side Panel
  // hid media that had been detected and stored correctly all along. `pageUrl` stays as the fallback
  // for entries recorded before `tabUrl` existed and for the DOM/MAIN-world sources, which have no
  // tabId to resolve one from.
  items = origin
    ? collapseVariantShadowedEntries(
        all.filter((m) => {
          const scopeUrl = m.tabUrl ?? m.pageUrl;
          if (!scopeUrl) return false;
          try {
            return new URL(scopeUrl).origin === origin;
          } catch {
            return false;
          }
        }),
      )
    : [];
  render();
}

function resolveDownloadUrl(item: DetectedMedia): string {
  return selectedVariantUrl.get(item.id) ?? item.variants?.[0]?.url ?? item.url;
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
    activeDownloads.set(item.id, { phase: 'segments' });
    render();
    sendEngineCommand('START', item.id, url);
    return;
  }
  void chrome.downloads.download({ url: item.url });
}

/** docs/ROADMAP.md §7.6/§8.1 — settles the row back to normal after a 'done'/'error'/'cancelled'
 * phase: clears the progress state so the Download button comes back. No Tab to close anymore — the
 * engine's own job entry is already gone by the time it emits one of these terminal phases. */
function settleDownload(entryId: string): void {
  setTimeout(() => {
    activeDownloads.delete(entryId);
    render();
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
  render();
  if (message.phase === 'done' || message.phase === 'error' || message.phase === 'cancelled') settleDownload(message.jobId);
});

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
    return span({ class: 'download-progress-text' }, 'Done');
  }
  if (state.phase === 'remux') {
    return span({ class: 'download-progress-text' }, 'Remuxing...');
  }
  const total = state.total;
  const segmentText = total ? `Segment ${state.done ?? 0}/${total}` : 'Starting...';
  const etaText = state.etaMs !== undefined ? ` (${formatEta(state.etaMs)})` : '';
  return div(
    { class: 'download-progress' },
    total ? progressTag({ value: state.done ?? 0, max: total }) : progressTag(),
    span({ class: 'download-progress-text' }, state.phase === 'paused' ? `Paused — ${segmentText}` : `${segmentText}${etaText}`),
  );
}

function renderItem(item: DetectedMedia) {
  const variantSelect =
    item.variants && item.variants.length > 0
      ? select(
          {
            onchange: (e: Event) => selectedVariantUrl.set(item.id, (e.target as HTMLSelectElement).value),
          },
          ...item.variants.map((v, i) => option({ value: v.url, selected: i === 0 }, v.resolution ?? `Variant ${i + 1}`)),
        )
      : null;
  const summary = resolutionSummary(item);
  const downloadProgress = activeDownloads.get(item.id);

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
        : button(
            { class: 'download-btn', title: 'Download', 'aria-label': 'Download', onclick: () => handleDownload(item) },
            img({ src: downloadIconUrl, alt: '' }),
          ),
    ),
    // Own full-width row, not sharing .media-item-actions with the resolution <select> — a
    // <progress> bar/status line squeezed into that row's remaining space (next to the select) was
    // cramped and easy to miss.
    downloadProgress
      ? div(
          { class: 'media-item-progress' },
          renderDownloadProgress(downloadProgress),
          // docs/ROADMAP.md §8.1 — Pause/Resume/Cancel only make sense while the segment pool is
          // actually running (or paused mid-run); the engine has no cancellation checkpoint during
          // 'remux' (ffmpeg has already started), and the terminal phases are about to settle away
          // on their own.
          downloadProgress.phase === 'segments' || downloadProgress.phase === 'paused'
            ? div(
                { class: 'download-controls' },
                button(
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

function render(): void {
  root.replaceChildren();
  van.add(
    root,
    div(
      { class: 'panel-header' },
      h1('Media Sniffer'),
      button({ class: 'secondary', title: 'Settings', onclick: openDashboard }, '⚙'),
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
