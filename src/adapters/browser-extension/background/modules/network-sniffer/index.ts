import type { Module } from '../../../../../kernel/module';
import type { CollectionCommand } from '../../../../../kernel/ui-schema';
import { classifyMediaUrl, classifyMediaMimeType, type MediaKind } from '../../../../../shared/media-url-matcher';
import { isAdNetworkDomain } from '../../../../../shared/ad-domain-denylist';
import { looksLikeAdOrTrackerPath } from '../../../../../shared/junk-url-patterns';
import { ensureNetworkObserver, teardownNetworkObserver, type ObservedRequest } from '../../../utils/webrequest-media-observer';
import {
  isMainWorldScriptRegistered,
  registerMainWorldScript,
  unregisterMainWorldScript,
} from '../../../utils/main-world-injector';
import { isModuleActive } from '../../../module-registry/storage';
// `&iife`, not `&module` — see main-world-interceptor skill: chrome.scripting always injects `js`
// entries as a classic script, and a raw ES module chunk (real `import` statements) throws a
// SyntaxError before a single line runs. `&iife` inlines every dependency into one self-contained
// file with zero `import` statements.
import payloadPath from './main-world-payload?script&iife';
import { MAIN_WORLD_SCRIPT_ID } from './constants';
import { addDetectedMedia, listDetectedMedia, removeDetectedMedia, updateDetectedMedia, type DetectedMedia } from './store';
import { parseM3u8 } from '../../../../../shared/media-manifest-parser';

/** docs/ROADMAP.md #5.2 — combines both junk signals (static domain denylist + path/query keyword
 * heuristic) into the one check used at all three detection entry points below. The keyword half
 * catches an ad/tracker request the domain list doesn't name yet (a new domain, or one that rotates
 * — DGA-style), without needing the list updated first. */
function isJunkUrl(url: string): boolean {
  return isAdNetworkDomain(url) || looksLikeAdOrTrackerPath(url);
}

/**
 * docs/ROADMAP.md #4.1's junk-URL filtering, the "what counts as media" policy half (the observer
 * mechanism itself has zero opinion — see webrequest-media-observer.ts's doc comment).
 *
 * `resourceType === 'media'` means Chrome itself already classified this as a real media fetch —
 * unchanged behavior, Content-Type kind preferred when present, URL-extension fallback otherwise
 * (exactly as before this filtering was added). Anything else (`xmlhttprequest`/`object`/`other`)
 * is the noisy bucket where a URL merely *looking* like media (an ad/analytics XHR ending in
 * `.mp4`, say) used to be enough on its own — now it REQUIRES a genuine, server-confirmed
 * Content-Type match, UNLESS the URL is already unambiguously a stream manifest (`.m3u8`/`.mpd`):
 * unlike `.mp4`/`.mp3`, an ad/analytics endpoint essentially never happens to end in a manifest
 * extension, and a lot of manifest servers are sloppy about Content-Type — a hls.js/dash.js-style
 * player's own manifest fetch (often issued from a Worker, which `chrome.webRequest` still sees
 * fine even though the MAIN-world observer's `window.fetch` patch can't) was getting silently
 * dropped here, exactly the case docs/ROADMAP.md #4.1's MAIN-world/blob: correlation work exists
 * to rescue — trusting the URL alone for `stream` closes that gap without reopening the original
 * `video`/`audio` false-positive problem this filtering was added for. A response with no/mismatched
 * Content-Type is still silently excluded for `video`/`audio`, same "partial result over false
 * positive" posture as fetch-images'/crawlSite's per-item skip.
 *
 * docs/ROADMAP.md #5.2 — checked first, ahead of the resourceType/Content-Type split above: a junk
 * URL (known ad-network domain, or an ad/tracker-shaped path/query) is rejected outright regardless
 * of resourceType, since these networks routinely serve real `video/*` Content-Types for what's
 * still an ad, which the `resourceType === 'media'` branch would otherwise trust unconditionally.
 */
function classifyDetection(req: ObservedRequest): MediaKind | undefined {
  if (isJunkUrl(req.url)) return undefined;
  const urlKind = classifyMediaUrl(req.url);
  const mimeKind = req.contentType ? classifyMediaMimeType(req.contentType) : undefined;
  if (req.resourceType === 'media') return mimeKind ?? urlKind;
  if (urlKind === 'stream') return 'stream';
  return mimeKind;
}

/** Sent directly by content-scripts/dom-media-observer.ts (docs/ROADMAP.md #4 Phase 1) via
 * `chrome.runtime.sendMessage({event: 'network-sniffer', payload: ...})` — a second detection
 * source alongside chrome.webRequest, not part of the generic CollectionCommand wire shape (this
 * op is specific to this Module, not a generic Dashboard CRUD write). */
interface ReportDomMediaCommand {
  op: 'report-dom-media';
  items: { url: string; pageUrl?: string }[];
}

/** Sent by content-scripts/index.ts, relaying main-world-payload.ts's MAIN-world channel report
 * (docs/ROADMAP.md #4.1's third detection source) — same "module-specific op, bypasses the generic
 * CollectionCommand shape" reasoning as ReportDomMediaCommand above. */
interface ReportMainWorldMediaCommand {
  op: 'report-main-world-media';
  url: string;
}

/** Sent by the Management View's "Inspect" rowAction (docs/ROADMAP.md #5.1, kernel/ui-schema.ts's
 * `'trigger'` UIRowAction) — `id` is the DetectedMedia entry to fetch+parse as an HLS manifest.
 * Same "module-specific op, bypasses CollectionCommand" reasoning as the two commands above. */
interface InspectCommand {
  op: 'inspect';
  id: string;
}

/** docs/ROADMAP.md #4.1's third-party/initiator-origin signal — a LABEL, not a filter (see
 * DetectedMedia.thirdParty's doc comment for why hard-filtering on this would be wrong). Returns
 * `undefined` (unknown, not a claim either way) when the tab's URL can't be read (e.g. a chrome://
 * page, or the tab closed between detection and this lookup) rather than guessing. */
async function isThirdPartyInitiator(tabId: number, initiator: string): Promise<boolean | undefined> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) return undefined;
    return new URL(initiator).hostname !== new URL(tab.url).hostname;
  } catch {
    return undefined;
  }
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
 * ("dismiss this entry") and per-row Download/Inspect actions (UICollectionSchema's `rowActions`).
 */
export const NetworkSnifferModule: Module<
  CollectionCommand<DetectedMedia> | ReportDomMediaCommand | ReportMainWorldMediaCommand | InspectCommand | undefined,
  void
> = {
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
    // docs/ROADMAP.md #5.2 — `thirdParty` (#4.1) was a pure label until now; this makes it actually
    // reduce visible row count, without losing the entries (still there behind "Show hidden").
    defaultHideField: 'thirdParty',
    // 'Inspect'/'Download (merged)' are on every row unconditionally, not just 'stream'-kind ones
    // (docs/ROADMAP.md #5.1/#5.3) — both no-op/error gracefully on a URL that isn't an HLS media
    // playlist (ParsedManifest's {kind:'unknown'} for Inspect, the Merge page's own error state for
    // Download (merged)), so a per-row show/hide condition would be pure overhead for the same
    // result.
    rowActions: [
      { kind: 'download', label: 'Download', urlField: 'url' },
      { kind: 'trigger', label: 'Inspect', op: 'inspect' },
      { kind: 'open-tab', label: 'Download (merged)', urlField: 'url', path: 'src/adapters/browser-extension/ui/merge/index.html' },
    ],
    fields: [
      { key: 'url', label: 'URL', type: 'string' },
      { key: 'kind', label: 'Type', type: 'string' },
      { key: 'pageUrl', label: 'Found on', type: 'string' },
      { key: 'detectedAt', label: 'Detected', type: 'string' },
      {
        key: 'thirdParty',
        label: 'Third-party?',
        hint: 'Best-effort signal only — a legitimate video is often served from a different-origin CDN too, this is not a reliable ad indicator on its own',
        type: 'boolean',
      },
      {
        key: 'resolution',
        label: 'Resolution',
        hint: 'Set on a stream entry created by Inspect-ing a master HLS playlist — one entry per resolution variant',
        type: 'string',
      },
      {
        key: 'segmentCount',
        label: 'Segments',
        hint: 'Set by Inspect once a stream entry is confirmed to be a media/variant HLS playlist, not a master listing other resolutions',
        type: 'number',
      },
      {
        key: 'encrypted',
        label: 'DRM?',
        hint: 'Set by Inspect — an EXT-X-KEY other than NONE was present (Widevine/EME), not independently downloadable',
        type: 'boolean',
      },
    ],
  },
  listCollection: async () => (await listDetectedMedia()) as unknown as Record<string, unknown>[],
  async run(command, ctx) {
    if (!(await isModuleActive('network-sniffer'))) {
      teardownNetworkObserver();
      if (await isMainWorldScriptRegistered(MAIN_WORLD_SCRIPT_ID)) {
        await unregisterMainWorldScript(MAIN_WORLD_SCRIPT_ID);
      }
      return;
    }

    // Idempotent — safe to call on every bus event (startup 'sync', or a Delete command), only
    // actually installs the chrome.webRequest listener the first time.
    ensureNetworkObserver((req) => {
      const kind = classifyDetection(req);
      if (!kind) return;
      void (async () => {
        // Only computable when the observer gave us an initiator — the only source with a
        // tabId+initiator in hand (docs/ROADMAP.md #4.1's third-party signal).
        const thirdParty = req.initiator ? await isThirdPartyInitiator(req.tabId, req.initiator) : undefined;
        // exactOptionalPropertyTypes: only include a field when actually available, never `undefined`.
        const media: DetectedMedia = {
          id: crypto.randomUUID(),
          url: req.url,
          kind,
          detectedAt: new Date().toISOString(),
          ...(req.initiator ? { pageUrl: req.initiator } : {}),
          ...(thirdParty !== undefined ? { thirdParty } : {}),
        };
        // docs/ROADMAP.md #4.2 — only push the float-widget notice on a genuine new detection (not
        // a repeat request for an already-known URL), same "don't spam a chatty page" philosophy as
        // the store's own dedupe/cap.
        if (await addDetectedMedia(media, ctx.services.cache)) notifyTabMediaFound(req.tabId);
      })();
    });

    // Always (re-)register while active, not just when nothing is registered yet — same
    // stale-jsPath-avoidance reasoning as http-error-mocker's syncRegistration (Vite content-hashes
    // the built filename on every rebuild).
    await registerMainWorldScript({
      id: MAIN_WORLD_SCRIPT_ID,
      matches: ['<all_urls>'],
      jsPath: payloadPath,
      runAt: 'document_start',
    });

    if (command?.op === 'delete') {
      await removeDetectedMedia(command.id, ctx.services.cache);
    }

    if (command?.op === 'report-main-world-media') {
      // Re-validates server-side rather than trusting the content script's own relay — same "never
      // trust the shim to self-limit" posture as report-dom-media below. docs/ROADMAP.md #5.2 — same
      // junk check as classifyDetection's webRequest path, so this second detection source doesn't
      // reopen the ad-network hole the webRequest path just closed.
      const kind = !isJunkUrl(command.url) ? classifyMediaUrl(command.url) : undefined;
      if (kind) {
        await addDetectedMedia(
          { id: crypto.randomUUID(), url: command.url, kind, detectedAt: new Date().toISOString() },
          ctx.services.cache,
        );
      }
    }

    if (command?.op === 'report-dom-media') {
      // Re-validates server-side rather than trusting the content script's own filtering — same
      // "never trust the shim to self-limit" posture rpc-handler.ts already documents.
      for (const item of command.items) {
        if (isJunkUrl(item.url)) continue;
        const kind = classifyMediaUrl(item.url);
        if (!kind) continue;
        const media: DetectedMedia = item.pageUrl
          ? { id: crypto.randomUUID(), url: item.url, kind, pageUrl: item.pageUrl, detectedAt: new Date().toISOString() }
          : { id: crypto.randomUUID(), url: item.url, kind, detectedAt: new Date().toISOString() };
        await addDetectedMedia(media, ctx.services.cache);
      }
    }

    if (command?.op === 'inspect') {
      // docs/ROADMAP.md #5.1 — fetch+parse only reached via an explicit user click (the
      // Management View's "Inspect" rowAction), not run automatically on every detection: most
      // detected URLs aren't manifests at all, and even `stream`-kind ones may never get inspected.
      const entry = (await listDetectedMedia(ctx.services.cache)).find((m) => m.id === command.id);
      if (entry) {
        try {
          const manifest = parseM3u8(await (await fetch(entry.url)).text(), entry.url);
          if (manifest.kind === 'master') {
            // One NEW entry per resolution variant (dedupe-by-URL in addDetectedMedia makes a
            // repeat Inspect idempotent), inheriting the manifest entry's own pageUrl.
            for (const variant of manifest.variants) {
              const media: DetectedMedia = {
                id: crypto.randomUUID(),
                url: variant.url,
                kind: 'stream',
                detectedAt: new Date().toISOString(),
                ...(entry.pageUrl ? { pageUrl: entry.pageUrl } : {}),
                ...(variant.resolution ? { resolution: variant.resolution } : {}),
              };
              await addDetectedMedia(media, ctx.services.cache);
            }
          } else if (manifest.kind === 'media') {
            // Patches the inspected entry itself in place, not a new row. Only the count is
            // persisted here — the segment URLs themselves are re-fetched+parsed by the Merge page
            // (docs/ROADMAP.md #5.3) when the user actually clicks "Download (merged)", not stashed
            // in DetectedMedia (hundreds of URLs per stream, and stale the moment the manifest
            // rotates, unlike the count).
            await updateDetectedMedia(
              entry.id,
              { segmentCount: manifest.segments.length, encrypted: manifest.encrypted },
              ctx.services.cache,
            );
          }
          // {kind:'unknown'} — silent no-op, same as a fetch failure below.
        } catch {
          // Fetch failure or unparsable manifest — graceful no-op, same "partial result over
          // failure" posture as fetch-images'/crawlSite's per-item skip.
        }
      }
    }
  },
};
