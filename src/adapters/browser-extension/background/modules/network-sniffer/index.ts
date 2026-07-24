import type { Module } from '../../../../../kernel/module';
import type { CollectionCommand } from '../../../../../kernel/ui-schema';
import { classifyMediaUrl } from '../../../../../shared/media-url-matcher';
import { ensureNetworkObserver, teardownNetworkObserver } from '../../../utils/webrequest-media-observer';
import { isModuleActive } from '../../../module-registry/storage';
import { addDetectedMedia, listDetectedMedia, removeDetectedMedia, type DetectedMedia } from './store';

/** Sent directly by content-scripts/dom-media-observer.ts (docs/ROADMAP.md #4 Phase 1) via
 * `chrome.runtime.sendMessage({event: 'network-sniffer', payload: ...})` — a second detection
 * source alongside chrome.webRequest, not part of the generic CollectionCommand wire shape (this
 * op is specific to this Module, not a generic Dashboard CRUD write). */
interface ReportDomMediaCommand {
  op: 'report-dom-media';
  items: { url: string; pageUrl?: string }[];
}

/** Fire-and-forget push to a specific tab telling its top-frame content script new media was
 * found — docs/ROADMAP.md #4.2's In-Page Float Widget. Only reached from the `webRequest` path
 * below: the DOM-detection path (dom-media-observer.ts) shows its own badge locally without a
 * round trip, since it already has the element and URL in hand — this toast is purely the
 * fallback for media `chrome.webRequest` sees but that has no corresponding on-page DOM element to
 * anchor a badge to (e.g. a JS player using MediaSource/blob:, so nothing in the DOM to point at).
 * No count/URL in the payload on purpose: the content-script listener (content-scripts/index.ts)
 * owns composing the display message and building the Dashboard link, this module just signals
 * "something new happened on this tab". */
function notifyTabMediaFound(tabId: number): void {
  chrome.tabs.sendMessage(tabId, { type: 'synapse:media-found' }).catch(() => {
    // No content script listening on this tab (e.g. a chrome:// page) — not an error.
  });
}

// docs/ROADMAP.md #4.2 — the anchored badge's click handler (dom-media-observer.ts) can't call
// chrome.downloads.download() itself (content scripts don't have that API), so it messages
// background to do it instead. Registered unconditionally at module load (not inside run()'s
// install-once pattern) since it's stateless — isModuleActive is checked per-message instead.
chrome.runtime.onMessage.addListener((message: { type?: string; url?: string } | undefined) => {
  if (message?.type !== 'synapse:download-media' || !message.url) return;
  const url = message.url;
  void (async () => {
    // Re-validates rather than trusting the content script's own filtering — same "never trust the
    // shim to self-limit" posture as run()'s own report-dom-media branch below.
    if (!(await isModuleActive('network-sniffer')) || !classifyMediaUrl(url)) return;
    await chrome.downloads.download({ url });
  })();
});

/**
 * Background Module (docs/design.md §3.B, "browser-specific non-dom Modules") — the first concrete
 * use case for docs/ROADMAP.md #4's Generic Network Sniffer direction. `chrome.webRequest` is
 * background/service-worker-only (unreachable from a content script), so — unlike
 * reader-mode-converter — this can't be a `dom` Module; it's `needs: ['bus', 'cache']` instead,
 * same shape http-error-mocker uses for its `debugger`/`dnr` mechanisms.
 *
 * Read-only Collection schema: detected media is a running, capped log across all tabs (not
 * scoped to "the active tab" — the Dashboard opens in its own tab, which would otherwise be the
 * "active tab" by the time anyone reads it), so there's no sensible Add/Edit, only Delete
 * ("dismiss this entry") and a per-row Download action (UICollectionSchema's `rowAction`).
 */
export const NetworkSnifferModule: Module<CollectionCommand<DetectedMedia> | ReportDomMediaCommand | undefined, void> = {
  id: 'network-sniffer',
  label: 'Media Sniffer',
  description: 'Passively detects video/audio/stream URLs requested by pages you visit, and lets you download them.',
  needs: ['bus', 'cache'],
  // docs/ROADMAP.md #4.2 — this Module also pushes an on-page floating widget (utils/
  // floating-widget.ts) when it detects media, instead of only surfacing results in the Dashboard.
  uiParadigm: 'float-widget',
  uiSchema: {
    kind: 'collection',
    itemLabel: 'detected media',
    idField: 'id',
    readOnly: true,
    rowAction: { label: 'Download', urlField: 'url' },
    fields: [
      { key: 'url', label: 'URL', type: 'string' },
      { key: 'kind', label: 'Type', type: 'string' },
      { key: 'pageUrl', label: 'Found on', type: 'string' },
      { key: 'detectedAt', label: 'Detected', type: 'string' },
    ],
  },
  listCollection: async () => (await listDetectedMedia()) as unknown as Record<string, unknown>[],
  async run(command, ctx) {
    if (!(await isModuleActive('network-sniffer'))) {
      teardownNetworkObserver();
      return;
    }

    // Idempotent — safe to call on every bus event (startup 'sync', or a Delete command), only
    // actually installs the chrome.webRequest listener the first time.
    ensureNetworkObserver((req) => {
      const kind = classifyMediaUrl(req.url);
      if (!kind) return;
      // exactOptionalPropertyTypes: only include `pageUrl` when the observer actually provided one.
      const media: DetectedMedia = req.initiator
        ? { id: crypto.randomUUID(), url: req.url, kind, pageUrl: req.initiator, detectedAt: new Date().toISOString() }
        : { id: crypto.randomUUID(), url: req.url, kind, detectedAt: new Date().toISOString() };
      // docs/ROADMAP.md #4.2 — only push the float-widget notice on a genuine new detection (not
      // a repeat request for an already-known URL), same "don't spam a chatty page" philosophy as
      // the store's own dedupe/cap.
      void addDetectedMedia(media, ctx.services.cache).then((inserted) => {
        if (inserted) notifyTabMediaFound(req.tabId);
      });
    });

    if (command?.op === 'delete') {
      await removeDetectedMedia(command.id, ctx.services.cache);
    }

    if (command?.op === 'report-dom-media') {
      // Re-validates server-side rather than trusting the content script's own filtering — same
      // "never trust the shim to self-limit" posture rpc-handler.ts already documents.
      for (const item of command.items) {
        const kind = classifyMediaUrl(item.url);
        if (!kind) continue;
        const media: DetectedMedia = item.pageUrl
          ? { id: crypto.randomUUID(), url: item.url, kind, pageUrl: item.pageUrl, detectedAt: new Date().toISOString() }
          : { id: crypto.randomUUID(), url: item.url, kind, detectedAt: new Date().toISOString() };
        await addDetectedMedia(media, ctx.services.cache);
      }
    }
  },
};
