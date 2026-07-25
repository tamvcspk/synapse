import '@picocss/pico/css/pico.min.css';
import './side-panel.css';
import van from 'vanjs-core';
import { listDetectedMedia, type DetectedMedia } from '../../background/modules/network-sniffer/store';
import { DASHBOARD_PATH } from '../dashboard/dashboard-path';
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

// Same literal path network-sniffer/index.ts's 'open-tab' rowAction already uses — no shared
// constant exists for it (that rowAction is declared inline in the module's uiSchema).
const MERGE_PATH = 'src/adapters/browser-extension/ui/merge/index.html';

const root = document.getElementById('root')!;

let items: DetectedMedia[] = [];
// Which variant URL is currently selected per master-playlist entry (entry.id -> variant url) —
// UI-only state, never persisted.
const selectedVariantUrl = new Map<string, string>();

// docs/ROADMAP.md §7.6 — one in-flight background download per detected-media entry id, fed by
// `synapse:merge-progress` messages from the Merge Tab this panel itself opened (handleDownload
// below). UI-only, never persisted: reloading the Side Panel just loses the progress display, the
// background Tab keeps running regardless (same "no persistence" posture as the download itself).
interface DownloadProgress {
  phase: 'segments' | 'remux' | 'done' | 'error';
  done?: number | undefined;
  total?: number | undefined;
  message?: string | undefined;
  tabId?: number | undefined;
}
const activeDownloads = new Map<string, DownloadProgress>();
// Gives the 'done'/'error' state a moment on screen before the Tab (and this row's progress UI)
// disappears — long enough to read "Done"/"Failed: ...", short enough not to feel stuck.
const DOWNLOAD_SETTLE_DELAY_MS = 1500;

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
  // `pageUrl` is an origin already (webRequest's `initiator`), not a full URL with path — compare
  // by origin, not exact string, and drop entries with no `pageUrl` at all (nothing to scope them
  // to — see store.ts's doc comment on this being a rare case).
  items = origin
    ? all.filter((m) => {
        if (!m.pageUrl) return false;
        try {
          return new URL(m.pageUrl).origin === origin;
        } catch {
          return false;
        }
      })
    : [];
  render();
}

function resolveDownloadUrl(item: DetectedMedia): string {
  return selectedVariantUrl.get(item.id) ?? item.variants?.[0]?.url ?? item.url;
}

function handleDownload(item: DetectedMedia): void {
  if (item.kind === 'stream') {
    if (activeDownloads.has(item.id)) return; // already downloading this entry
    // DRM guard (`encrypted`) is enforced by the Merge page itself once it re-fetches+parses the
    // manifest — not duplicated here (docs/ROADMAP.md §6.3).
    const url = resolveDownloadUrl(item);
    const tabUrl = `${chrome.runtime.getURL(MERGE_PATH)}?url=${encodeURIComponent(url)}&entryId=${encodeURIComponent(item.id)}`;
    // docs/ROADMAP.md §7.6 — background Tab (doesn't steal focus), auto-runs on its own once
    // loaded; this panel just tracks its progress via the message listener below and shows an
    // inline <progress> bar in place of the Download button until it settles.
    activeDownloads.set(item.id, { phase: 'segments' });
    render();
    void chrome.tabs
      .create({ url: tabUrl, active: false })
      .then((tab) => {
        const state = activeDownloads.get(item.id);
        if (state) state.tabId = tab.id;
      })
      .catch(() => {
        activeDownloads.delete(item.id);
        render();
      });
    return;
  }
  void chrome.downloads.download({ url: item.url });
}

/** docs/ROADMAP.md §7.6 — settles the row back to normal after a 'done'/'error' phase: closes the
 * background Tab (best-effort — it may have already closed itself or been closed by the user) and
 * clears the progress state so the Download button comes back. */
function settleDownload(entryId: string): void {
  setTimeout(() => {
    const state = activeDownloads.get(entryId);
    if (state?.tabId !== undefined) void chrome.tabs.remove(state.tabId).catch(() => {});
    activeDownloads.delete(entryId);
    render();
  }, DOWNLOAD_SETTLE_DELAY_MS);
}

chrome.runtime.onMessage.addListener((message: Partial<DownloadProgress> & { type?: string; entryId?: string } | undefined) => {
  if (message?.type !== 'synapse:merge-progress' || !message.entryId || !message.phase) return;
  const existing = activeDownloads.get(message.entryId);
  activeDownloads.set(message.entryId, {
    ...existing,
    phase: message.phase,
    done: message.done,
    total: message.total,
    message: message.message,
  });
  render();
  if (message.phase === 'done' || message.phase === 'error') settleDownload(message.entryId);
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

/** docs/ROADMAP.md §7.6 — replaces the Download button while a `kind:'stream'` entry's Merge Tab is
 * running in the background, so the row shows what's happening instead of looking clickable-but-
 * inert. `'segments'`'s `total` is only known once the Merge Tab has fetched+parsed the manifest
 * itself, so it renders a bare "Starting…" line until the first per-segment message arrives. */
function renderDownloadProgress(state: DownloadProgress) {
  if (state.phase === 'error') {
    return span({ class: 'download-progress-text download-progress-error' }, `Failed: ${state.message ?? 'unknown error'}`);
  }
  if (state.phase === 'done') {
    return span({ class: 'download-progress-text' }, 'Done');
  }
  if (state.phase === 'remux') {
    return span({ class: 'download-progress-text' }, 'Remuxing...');
  }
  const total = state.total;
  return div(
    { class: 'download-progress' },
    total ? progressTag({ value: state.done ?? 0, max: total }) : progressTag(),
    span({ class: 'download-progress-text' }, total ? `Segment ${state.done ?? 0}/${total}` : 'Starting...'),
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
        ? renderDownloadProgress(downloadProgress)
        : button(
            { class: 'download-btn', title: 'Download', 'aria-label': 'Download', onclick: () => handleDownload(item) },
            img({ src: downloadIconUrl, alt: '' }),
          ),
    ),
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
