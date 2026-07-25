import type { CacheService, Module } from '../../../../../kernel/module';
import type { CollectionCommand } from '../../../../../kernel/ui-schema';
import { classifyMediaUrl, classifyMediaMimeType, type MediaKind } from '../../../../../shared/media-url-matcher';
import { isAdNetworkDomain } from '../../../../../shared/ad-domain-denylist';
import { looksLikeAdOrTrackerPath, looksLikeAdMacroTemplate } from '../../../../../shared/junk-url-patterns';
import { ensureNetworkObserver, teardownNetworkObserver, type ObservedRequest } from '../../../utils/webrequest-media-observer';
import { syncHeaderReplayRule } from '../../../utils/header-replay-rules';
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
import { chromeStorageCache } from '../../services/cache';

/** docs/ROADMAP.md #5.2 — combines both junk signals (static domain denylist + path/query keyword
 * heuristic) into the one check used at all three detection entry points below. The keyword half
 * catches an ad/tracker request the domain list doesn't name yet (a new domain, or one that rotates
 * — DGA-style), without needing the list updated first. `looksLikeAdMacroTemplate` catches a third
 * shape: a literal un-substituted `{macro}` query value, seen on real ad-tracker redirect pages
 * whose domain/path otherwise didn't match anything above. */
function isJunkUrl(url: string): boolean {
  return isAdNetworkDomain(url) || looksLikeAdOrTrackerPath(url) || looksLikeAdMacroTemplate(url);
}

/** docs/ROADMAP.md §6.5 — a request's OWN url can look completely clean (e.g. a legitimate-looking
 * CDN filename) while the PAGE/FRAME that made the request is itself an ad-tracker redirect page
 * (classic pattern: an ad iframe's own src is a tracker/redirect URL, which then loads a real media
 * file from a separate, innocuous-looking CDN domain). Checking the request's own url isn't enough
 * on its own — also check `pageUrl`/`initiator` wherever the caller has one in hand. */
function isJunkRequest(url: string, pageUrl: string | undefined): boolean {
  return isJunkUrl(url) || (pageUrl !== undefined && isJunkUrl(pageUrl));
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
  if (isJunkRequest(req.url, req.initiator)) return undefined;
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
 * CollectionCommand shape" reasoning as ReportDomMediaCommand above. `pageUrl` (added docs/ROADMAP.md
 * §6.5, `location.href` at the sender) is required for the Side Panel's per-tab scoping (§6.3) to
 * ever show an entry detected via this source — previously omitted entirely. */
interface ReportMainWorldMediaCommand {
  op: 'report-main-world-media';
  url: string;
  pageUrl?: string;
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
 * found — shows the floating icon (docs/ROADMAP.md §6.1's `showFloatingIcon`), which opens the
 * Side Panel on click. docs/ROADMAP.md §6.3 widened this to fire from every `addDetectedMedia`
 * success path (webRequest, report-main-world-media, report-dom-media), not just `webRequest` as
 * before — the floating icon now stands in for what used to be the DOM-detection path's own local
 * badge draw too, so it needs to know about every source, not only the one with no DOM element to
 * anchor to. No count/URL in the payload on purpose: the content-script listener
 * (content-scripts/index.ts) just shows/keeps the icon visible, the Side Panel itself is the
 * source of truth for the actual list. */
function notifyTabMediaFound(tabId: number): void {
  chrome.tabs.sendMessage(tabId, { type: 'synapse:media-found' }).catch(() => {
    // No content script listening on this tab (e.g. a chrome:// page) — not an error.
  });
}

/** docs/ROADMAP.md §6.3 — fetch+parse a `kind:'stream'` entry's manifest, called automatically
 * right after it's newly added (no more explicit user-facing "Inspect" step). A *master* playlist's
 * variants are folded into `variants` on the SAME entry (one real video = one Side Panel item,
 * however many resolutions it offers) rather than each becoming its own new `DetectedMedia` row
 * (that was #5.1's original behavior). A *media/variant* playlist patches `segmentCount`/
 * `encrypted` in place, same as before. */
async function inspectStreamEntry(entry: DetectedMedia, cache: CacheService = chromeStorageCache): Promise<void> {
  try {
    // docs/ROADMAP.md #7.1 — replay the original page request's Referer/Origin/User-Agent before
    // this background fetch, for hosts that hotlink-protect on them. No-op when this entry has no
    // captured headers (the common case). Scoped to entry.url's own host — the manifest and its
    // segments (fetched later by the Merge page, not here) are typically same-CDN-host.
    if (entry.requestHeaders) {
      await syncHeaderReplayRule(new URL(entry.url).hostname, entry.requestHeaders);
    }
    const manifest = parseM3u8(await (await fetch(entry.url)).text(), entry.url);
    if (manifest.kind === 'master') {
      await updateDetectedMedia(entry.id, { variants: manifest.variants }, cache);
    } else if (manifest.kind === 'media') {
      // Segment URLs themselves are re-fetched+parsed by the Merge page (docs/ROADMAP.md #5.3) when
      // the user actually clicks Download, not stashed here (hundreds of URLs per stream, and stale
      // the moment the manifest rotates, unlike the count).
      await updateDetectedMedia(entry.id, { segmentCount: manifest.segments.length, encrypted: manifest.encrypted }, cache);
    }
    // {kind:'unknown'} — silent no-op, same as a fetch failure below.
  } catch {
    // Fetch failure or unparsable manifest — graceful no-op, same "partial result over failure"
    // posture as fetch-images'/crawlSite's per-item skip.
  }
}

// docs/ROADMAP.md §6.3 — a second, independent listener on the SAME `report-dom-media` bus message
// the Kernel/run() also handles below (Chrome allows multiple onMessage listeners per message; this
// one only peeks at `sender` for the tabId, which the generic BusService.on() handler shape doesn't
// expose). dom-media-observer.ts runs in every frame (frame-media-observer.ts, all_frames:true), so
// this is the only way to notify the top frame's floating icon when the detection happened in a
// nested/cross-origin iframe — chrome.tabs.sendMessage broadcasts to every frame with no frameId,
// but only content-scripts/index.ts's top-frame instance is listening for `synapse:media-found`.
chrome.runtime.onMessage.addListener((message: { event?: string; payload?: { op?: string } } | undefined, sender) => {
  if (message?.event !== 'network-sniffer' || message.payload?.op !== 'report-dom-media' || !sender.tab?.id) return;
  notifyTabMediaFound(sender.tab.id);
});

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
 * ("dismiss this entry") and per-row Download actions (UICollectionSchema's `rowActions`). The
 * primary UI is now the Side Panel (docs/ROADMAP.md §6) — this Management View stays as a
 * secondary, unscoped-to-tab view of the same underlying log.
 */
export const NetworkSnifferModule: Module<
  CollectionCommand<DetectedMedia> | ReportDomMediaCommand | ReportMainWorldMediaCommand | undefined,
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
    // docs/ROADMAP.md §6.8 — single "Download" button, same one-action UX the Side Panel already
    // has (docs/ROADMAP.md §6): `kind:'video'|'audio'` downloads straight via `chrome.downloads`,
    // `kind:'stream'` opens the Merge tab instead (`openTabKinds`) — no-op/errors gracefully on a
    // URL that isn't an HLS media playlist (the Merge page's own error state). Manifest inspection
    // itself is no longer a user-facing rowAction (docs/ROADMAP.md §6.3 — auto-inspect runs
    // automatically on every `stream`-kind detection now, see inspectStreamEntry above). Reads
    // `downloadUrl` (below), not `url` — a master-playlist entry's OWN `url` is just the manifest
    // listing other resolutions, not downloadable/mergeable on its own since §6.3 folded its
    // variants into `variants` instead of separate rows; `downloadUrl` resolves to the first
    // variant automatically (same default the Side Panel's own `<select>` starts on) — the
    // `variantsField` column below lets a row pick a different resolution instead of that default.
    rowActions: [
      {
        kind: 'smart-download',
        label: 'Download',
        urlField: 'downloadUrl',
        kindField: 'kind',
        openTabKinds: ['stream'],
        path: 'src/adapters/browser-extension/ui/merge/index.html',
      },
    ],
    // docs/ROADMAP.md §6.8 — one row per video even when its manifest has N resolutions (§6.3
    // already folds them onto one entry's `variants`); this surfaces them as their own column of
    // clickable options instead of leaving them invisible (previously only `downloadUrl`'s silent
    // first-variant default used `variants` at all). `variantLinks` is computed in listCollection()
    // below, same reasoning as `downloadUrl` — `{url,resolution}[]` renamed to the generic
    // `{url,label}[]` shape management-view.ts's variantsField rendering expects.
    variantsField: 'variantLinks',
    variantsLabel: 'Resolutions',
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
        hint: 'Set when this entry itself is a single, already-resolved HLS media/variant playlist',
        type: 'string',
      },
      {
        key: 'segmentCount',
        label: 'Segments',
        hint: 'Set by auto-inspect once a stream entry is confirmed to be a media/variant HLS playlist, not a master listing other resolutions',
        type: 'number',
      },
      {
        key: 'encrypted',
        label: 'DRM?',
        hint: 'Set by auto-inspect — an EXT-X-KEY other than NONE was present (Widevine/EME), not independently downloadable',
        type: 'boolean',
      },
    ],
  },
  // `downloadUrl` (docs/ROADMAP.md §6.5) is computed here, not stored — a master entry's own `url`
  // is the manifest listing other resolutions, not itself downloadable/mergeable; this resolves to
  // its first variant instead, same default the Side Panel's `<select>` starts on. `variantLinks`
  // (docs/ROADMAP.md §6.8) renames each variant's `resolution` to the generic `label` the schema's
  // `variantsField` column expects, falling back to a 1-based index for a variant whose manifest
  // never had an `EXT-X-STREAM-INF` bandwidth/resolution tag to read a label from.
  listCollection: async () =>
    (await listDetectedMedia()).map((m) => ({
      ...m,
      downloadUrl: m.variants?.[0]?.url ?? m.url,
      variantLinks: m.variants?.map((v, i) => ({ url: v.url, label: v.resolution ?? `Option ${i + 1}` })),
    })) as unknown as Record<string, unknown>[],
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
          // docs/ROADMAP.md #7.1 — only the webRequest source ever has the original request's own
          // headers in hand (report-dom-media/report-main-world-media never see them).
          ...(req.requestHeaders && Object.keys(req.requestHeaders).length > 0 ? { requestHeaders: req.requestHeaders } : {}),
        };
        // docs/ROADMAP.md #4.2 — only push the floating-icon notice on a genuine new detection (not
        // a repeat request for an already-known URL), same "don't spam a chatty page" philosophy as
        // the store's own dedupe/cap.
        if (await addDetectedMedia(media, ctx.services.cache)) {
          notifyTabMediaFound(req.tabId);
          if (kind === 'stream') void inspectStreamEntry(media, ctx.services.cache);
        }
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
      // trust the shim to self-limit" posture as report-dom-media below. docs/ROADMAP.md #5.2/§6.5 —
      // same junk check (now including pageUrl) as classifyDetection's webRequest path, so this
      // second detection source doesn't reopen the ad-network hole the webRequest path just closed.
      const kind = !isJunkRequest(command.url, command.pageUrl) ? classifyMediaUrl(command.url) : undefined;
      if (kind) {
        const media: DetectedMedia = {
          id: crypto.randomUUID(),
          url: command.url,
          kind,
          detectedAt: new Date().toISOString(),
          ...(command.pageUrl ? { pageUrl: command.pageUrl } : {}),
        };
        if (await addDetectedMedia(media, ctx.services.cache) && kind === 'stream') {
          void inspectStreamEntry(media, ctx.services.cache);
        }
      }
    }

    if (command?.op === 'report-dom-media') {
      // Re-validates server-side rather than trusting the content script's own filtering — same
      // "never trust the shim to self-limit" posture rpc-handler.ts already documents.
      for (const item of command.items) {
        if (isJunkRequest(item.url, item.pageUrl)) continue;
        const kind = classifyMediaUrl(item.url);
        if (!kind) continue;
        const media: DetectedMedia = item.pageUrl
          ? { id: crypto.randomUUID(), url: item.url, kind, pageUrl: item.pageUrl, detectedAt: new Date().toISOString() }
          : { id: crypto.randomUUID(), url: item.url, kind, detectedAt: new Date().toISOString() };
        if (await addDetectedMedia(media, ctx.services.cache) && kind === 'stream') {
          void inspectStreamEntry(media, ctx.services.cache);
        }
      }
    }
  },
};
