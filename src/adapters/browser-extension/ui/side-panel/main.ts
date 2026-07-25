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

const { div, h1, p, span, select, option, button, img } = van.tags;

// Same literal path network-sniffer/index.ts's 'open-tab' rowAction already uses — no shared
// constant exists for it (that rowAction is declared inline in the module's uiSchema).
const MERGE_PATH = 'src/adapters/browser-extension/ui/merge/index.html';

const root = document.getElementById('root')!;

let items: DetectedMedia[] = [];
// Which variant URL is currently selected per master-playlist entry (entry.id -> variant url) —
// UI-only state, never persisted.
const selectedVariantUrl = new Map<string, string>();

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
    // DRM guard (`encrypted`) is enforced by the Merge page itself once it re-fetches+parses the
    // manifest — not duplicated here (docs/ROADMAP.md §6.3).
    const url = resolveDownloadUrl(item);
    void chrome.tabs.create({ url: `${chrome.runtime.getURL(MERGE_PATH)}?url=${encodeURIComponent(url)}` });
    return;
  }
  void chrome.downloads.download({ url: item.url });
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
      button(
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
