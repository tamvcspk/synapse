import type { CacheService, Module } from '../../../../../kernel/module';
import type { CollectionCommand } from '../../../../../kernel/ui-schema';
import { classifyMediaUrl, classifyMediaMimeType, type MediaKind } from '../../../../../shared/media-url-matcher';
import { sniffMediaMagicBytes } from '../../../../../shared/media-magic-bytes';
import { isAdNetworkDomain, looksLikeAdHostnamePrefix } from '../../../../../shared/ad-domain-denylist';
import { looksLikeAdOrTrackerPath, looksLikeAdMacroTemplate } from '../../../../../shared/junk-url-patterns';
import { looksLikeSignedUrl } from '../../../../../shared/signed-url-detector';
import { describeResolution } from '../../../../../shared/resolution-label';
import { ensureNetworkObserver, type ObservedRequest } from '../../../utils/webrequest-media-observer';
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
import {
  addDetectedMedia,
  collapseVariantShadowedEntries,
  listDetectedMedia,
  removeDetectedMedia,
  updateDetectedMedia,
  type DetectedMedia,
} from './store';
import { parseM3u8 } from '../../../../../shared/media-manifest-parser';
import { chromeStorageCache } from '../../services/cache';

/** docs/ROADMAP.md #5.2 — combines both junk signals (static domain denylist + path/query keyword
 * heuristic) into the one check used at all three detection entry points below. The keyword half
 * catches an ad/tracker request the domain list doesn't name yet (a new domain, or one that rotates
 * — DGA-style), without needing the list updated first. `looksLikeAdMacroTemplate` catches a third
 * shape: a literal un-substituted `{macro}` query value, seen on real ad-tracker redirect pages
 * whose domain/path otherwise didn't match anything above. docs/ROADMAP.md #7.5 adds a fourth:
 * `looksLikeAdHostnamePrefix` catches a hostname LABEL (`creative.`/`ads.`/etc.) shared across many
 * unrelated ad operators, regardless of which registrable domain it sits on — `isAdNetworkDomain`
 * only ever matches domains already known by name. */
function isJunkUrl(url: string): boolean {
  return (
    isAdNetworkDomain(url) ||
    looksLikeAdOrTrackerPath(url) ||
    looksLikeAdMacroTemplate(url) ||
    looksLikeAdHostnamePrefix(url)
  );
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
/**
 * docs/ROADMAP.md #4 — the segment-spam exclusion `classifyMediaUrl` implements by extension (`.ts`/
 * `.m4s` are never listed) has a blind spot it cannot close on its own: a FRAGMENTED-MP4 (CMAF/
 * LL-HLS) stream names every one of its segments `.mp4`, which is indistinguishable from a real
 * standalone video by extension alone. Observed on a live LL-HLS stream that produced ~30 rows for
 * ONE video — an `_init_` segment, every 2-second segment, and every 0.5-second `#EXT-X-PART` part.
 *
 * The signal that does separate them is CONTEXT: a segment sits in the same directory as the
 * playlist that lists it, and its filename extends that playlist's own basename. Both facts are
 * already observable — the `.m3u8` is detected before its segments, since the player must read it
 * first. Deliberately requires the stem PREFIX to match rather than just the directory: a site
 * serving `/videos/trailer.mp4` alongside `/videos/playlist.m3u8` is offering a genuinely
 * downloadable file, and directory alone would suppress it.
 *
 * In-memory and therefore lost on a service-worker restart, which is why it is also seeded from the
 * store at startup (see the bottom of this file).
 */
const MAX_STREAM_DIRECTORIES = 100;
const streamStemsByDirectory = new Map<string, Set<string>>();

function urlDirAndStem(url: string): { dir: string; stem: string } | undefined {
  try {
    const { origin, pathname } = new URL(url);
    const slash = pathname.lastIndexOf('/');
    const file = pathname.slice(slash + 1);
    const dot = file.lastIndexOf('.');
    return { dir: `${origin}${pathname.slice(0, slash + 1)}`, stem: dot === -1 ? file : file.slice(0, dot) };
  } catch {
    return undefined;
  }
}

function rememberStreamManifest(url: string): void {
  const parts = urlDirAndStem(url);
  if (!parts || parts.stem.length < 3) return; // too short a stem would prefix-match unrelated files
  let stems = streamStemsByDirectory.get(parts.dir);
  if (!stems) {
    if (streamStemsByDirectory.size >= MAX_STREAM_DIRECTORIES) {
      // Oldest-first eviction (Map preserves insertion order), same bounded-memory posture as
      // header-replay-rules.ts's MAX_HOSTS.
      streamStemsByDirectory.delete(streamStemsByDirectory.keys().next().value as string);
    }
    stems = new Set();
    streamStemsByDirectory.set(parts.dir, stems);
  }
  stems.add(parts.stem);
}

function isSegmentOfKnownStream(url: string): boolean {
  const parts = urlDirAndStem(url);
  if (!parts) return false;
  const stems = streamStemsByDirectory.get(parts.dir);
  if (!stems) return false;
  // `>` not `>=`: a stem equal to the manifest's own is the manifest, not a segment of it.
  return [...stems].some((stem) => parts.stem.length > stem.length && parts.stem.startsWith(stem));
}

function classifyDetection(req: ObservedRequest): MediaKind | undefined {
  if (isJunkRequest(req.url, req.initiator)) return undefined;
  const urlKind = classifyMediaUrl(req.url);
  // Checked before the resourceType/Content-Type split below, not just within the non-'media'
  // branch — a manifest server's Content-Type is unreliable enough (real-world example: Google
  // Cloud Storage serving .m3u8 as `audio/mpegurl`, which Chrome then classifies as
  // `resourceType: 'media'` AND which `classifyMediaMimeType` reads as plain 'audio' — silently
  // downgrading an HLS manifest to a non-stream kind) that the URL extension alone should always
  // win for `.m3u8`/`.mpd`, regardless of what resourceType Chrome guessed.
  if (urlKind === 'stream') {
    rememberStreamManifest(req.url);
    return 'stream';
  }
  // Checked after the `stream` branch so a playlist is never mistaken for a segment of itself, and
  // before the Content-Type split below because a CMAF segment's Content-Type is a perfectly honest
  // `video/mp4` — no amount of server-confirmed typing distinguishes it from a standalone file.
  if (isSegmentOfKnownStream(req.url)) return undefined;
  const mimeKind = req.contentType ? classifyMediaMimeType(req.contentType) : undefined;
  if (req.resourceType === 'media') return mimeKind ?? urlKind;
  return mimeKind;
}

/**
 * Why a request the user COULD see in DevTools' Network tab never showed up in Synapse's list.
 *
 * Every rejection above is silent by construction — `classifyDetection` returns `undefined` for four
 * quite different reasons and the caller can't tell them apart. That gap has already cost real
 * debugging time: a plain `https://video.<cdn>/video/<hash>.mp4` went missing and the leading theory
 * was "the ad filter ate it", which this function can immediately confirm or refute instead of
 * leaving it a guess. Recomputes the checks rather than threading a reason out of `classifyDetection`
 * — it runs only on the reject path, and keeping the hot path's shape unchanged is worth the few
 * duplicated string comparisons.
 */
/**
 * Whether a rejected request is worth RECORDING a reason for. The observer no longer filters by
 * resource type at the browser level (see webrequest-media-observer.ts), so every stylesheet, script
 * and tracking pixel now reaches the reject path — logging all of them would push the one URL being
 * investigated out of the 100-entry ring buffer within a second of page load, i.e. break the
 * diagnostic in exactly the case it exists for. Records only what a reasonable person would expect
 * to see listed: something whose URL or Content-Type says media.
 */
function isWorthExplaining(req: ObservedRequest): boolean {
  if (classifyMediaUrl(req.url)) return true;
  const mime = req.contentType?.split(';')[0]?.trim().toLowerCase();
  return mime !== undefined && (mime.startsWith('video/') || mime.startsWith('audio/') || mime.includes('mpegurl') || mime.includes('dash+xml'));
}

function explainDetectionRejection(req: ObservedRequest): string {
  if (isJunkUrl(req.url)) {
    const which = isAdNetworkDomain(req.url)
      ? 'known ad-network domain'
      : looksLikeAdHostnamePrefix(req.url)
        ? 'ad-shaped hostname label (creative./ads./track./...)'
        : looksLikeAdMacroTemplate(req.url)
          ? 'un-substituted {macro} query value'
          : 'ad/tracker-shaped path segment or query key';
    return `junk: the URL itself matched — ${which}`;
  }
  if (req.initiator !== undefined && isJunkUrl(req.initiator)) {
    return `junk: the URL is clean but its INITIATOR (${req.initiator}) matched the ad filters — i.e. an ad frame requested it`;
  }
  if (isSegmentOfKnownStream(req.url)) {
    return 'stream segment: this sits in the same directory as an already-detected .m3u8 and its filename extends that playlist\'s basename, so it is one of its segments/parts (a CMAF/fMP4 segment is named .mp4 and is otherwise indistinguishable from a standalone video)';
  }
  const urlKind = classifyMediaUrl(req.url);
  if (urlKind && req.resourceType !== 'media') {
    return `Content-Type not confirmed: URL extension says '${urlKind}', but Chrome classified the request as '${req.resourceType}' (not 'media'), so a matching Content-Type was required and the server sent ${req.contentType ? `'${req.contentType}'` : 'none'}`;
  }
  if (!urlKind) {
    return `unrecognized: no media file extension, Content-Type was ${req.contentType ? `'${req.contentType}'` : 'absent'}, and the magic-bytes probe ${shouldProbeMagicBytes(req) ? 'found nothing' : 'was not eligible'}`;
  }
  return `no kind resolved (resourceType '${req.resourceType}', Content-Type ${req.contentType ?? 'absent'})`;
}

/** Last N rejections, newest last — a ring buffer because the reason is needed AFTER the fact ("why
 * isn't this video in the list?"), by which time the console line has usually scrolled away or the
 * service worker has restarted. Read it from the background console via
 * `globalThis.__synapseRejectedMedia` (see the assignment below). */
const MAX_RECORDED_REJECTIONS = 100;
const recentRejections: { url: string; reason: string; resourceType: string; at: string }[] = [];

function recordRejection(req: ObservedRequest, reasonOverride?: string): void {
  if (reasonOverride === undefined && !isWorthExplaining(req)) return;
  const reason = reasonOverride ?? explainDetectionRejection(req);
  recentRejections.push({ url: req.url, reason, resourceType: req.resourceType, at: new Date().toISOString() });
  if (recentRejections.length > MAX_RECORDED_REJECTIONS) recentRejections.shift();
  // console.debug, not warn/log: still one line per media-shaped request that didn't make the list,
  // which is common on an ad-heavy page — Chrome DevTools hides Verbose unless asked for it.
  console.debug(`Synapse: not listed as media (${req.resourceType}) — ${reason}\n  ${req.url}`);
}

// Debug-only handle on the background service worker's own global — the ring buffer is useless
// without a way to read it, and a real UI for it isn't worth building until this proves it's needed
// more than occasionally. Namespaced, read-only data, never read back by any code path.
(globalThis as unknown as Record<string, unknown>).__synapseRejectedMedia = recentRejections;

/**
 * docs/ROADMAP.md #7.2 — a request only qualifies for the magic-bytes rescue probe when
 * `classifyDetection` above is genuinely BLIND, not merely rejected: a URL extension already
 * recognized by `classifyMediaUrl` doesn't need probing (that path already works), and a junk
 * request (ad/tracker) shouldn't be probed at all — probing it would just spend a fetch confirming
 * what the junk filter already decided. The remaining case — Content-Type missing or one of the two
 * "server gave up classifying" values (`application/octet-stream`/`text/plain`) on a URL whose
 * extension is no help either — is the one real gap: a hls.js/dash.js-style manifest or a media file
 * served with no useful Content-Type at all.
 */
// The resource types this probe is willing to spend a fetch on. Pinned here now that the observer
// reports EVERY type (see webrequest-media-observer.ts): without it, "no Content-Type and no
// extension" would newly match fonts, beacons and pings, turning one page load into a burst of
// speculative range requests. This list is the same set the browser-level filter used to enforce.
const PROBEABLE_RESOURCE_TYPES: readonly string[] = ['media', 'xmlhttprequest', 'object', 'other'];

function shouldProbeMagicBytes(req: ObservedRequest): boolean {
  if (!PROBEABLE_RESOURCE_TYPES.includes(req.resourceType)) return false;
  if (isJunkRequest(req.url, req.initiator)) return false;
  if (classifyMediaUrl(req.url)) return false;
  const mime = req.contentType?.split(';')[0]?.trim().toLowerCase();
  return mime === undefined || mime === 'application/octet-stream' || mime === 'text/plain';
}

// docs/ROADMAP.md #7.2 — caps how many probe fetches can be in flight at once (a burst of blind
// requests on one busy page shouldn't turn into a burst of extra fetches), and remembers which
// origins have already been probed so the same CDN isn't probed over and over across its (likely
// many) blind requests — regardless of whether that first probe found anything. Deliberately
// unbounded/never evicted for the lifetime of the service worker: unlike header-replay-rules.ts's
// MAX_HOSTS=50 (a real chrome.declarativeNetRequest rule-count budget), this is just a plain JS Set
// with no comparable browser-imposed limit to guard against.
const probedMagicByteOrigins = new Set<string>();
let activeMagicByteProbes = 0;
const MAX_CONCURRENT_MAGIC_BYTE_PROBES = 4;

/** docs/ROADMAP.md #7.2 — the active half of the magic-bytes rescue: a small `Range` fetch instead
 * of touching the page's own response (MV3 has no `webRequest.filterResponseData` to do that even if
 * we wanted to — see the doc comment on media-magic-bytes.ts). Only ever called after
 * `shouldProbeMagicBytes` already said this request is worth it. A `'segment'` sniff result is
 * deliberately swallowed here, same as `classifyMediaUrl`'s existing exclusion of `.ts`/`.m4s` — a
 * recognized segment format still isn't something to list. */
async function probeMagicBytesKind(url: string): Promise<MediaKind | undefined> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return undefined;
  }
  if (probedMagicByteOrigins.has(origin) || activeMagicByteProbes >= MAX_CONCURRENT_MAGIC_BYTE_PROBES) return undefined;
  probedMagicByteOrigins.add(origin);
  activeMagicByteProbes++;
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
    const kind = sniffMediaMagicBytes(new Uint8Array(await res.arrayBuffer()));
    return kind === 'segment' ? undefined : kind;
  } catch {
    return undefined;
  } finally {
    activeMagicByteProbes--;
  }
}

/** Sent directly by content-scripts/dom-media-observer.ts (docs/ROADMAP.md #4 Phase 1) via
 * `chrome.runtime.sendMessage({event: 'network-sniffer', payload: ...})` — a second detection
 * source alongside chrome.webRequest, not part of the generic CollectionCommand wire shape (this
 * op is specific to this Module, not a generic Dashboard CRUD write). Handled by a standalone
 * `chrome.runtime.onMessage` listener below (docs/ROADMAP.md §10.4), not `run()`'s Bus dispatch —
 * see that listener's doc comment for why. */
interface ReportDomMediaCommand {
  op: 'report-dom-media';
  items: { url: string; pageUrl?: string }[];
}

/** Sent by content-scripts/index.ts, relaying main-world-payload.ts's MAIN-world channel report
 * (docs/ROADMAP.md #4.1's third detection source) — same "module-specific op, bypasses the generic
 * CollectionCommand shape" reasoning as ReportDomMediaCommand above. `pageUrl` (added docs/ROADMAP.md
 * §6.5, `location.href` at the sender) is required for the Side Panel's per-tab scoping (§6.3) to
 * ever show an entry detected via this source — previously omitted entirely. Handled by a
 * standalone `chrome.runtime.onMessage` listener below (docs/ROADMAP.md §10.4), not `run()`'s Bus
 * dispatch. */
interface ReportMainWorldMediaCommand {
  op: 'report-main-world-media';
  url: string;
  pageUrl?: string;
}

/** docs/ROADMAP.md #4.1's third-party/initiator-origin signal — a LABEL, not a filter (see
 * DetectedMedia.thirdParty's doc comment for why hard-filtering on this would be wrong). Returns
 * `undefined` (unknown, not a claim either way) when the tab's URL can't be read (e.g. a chrome://
 * page, or the tab closed between detection and this lookup) rather than guessing. */
async function describeTabContext(tabId: number, initiator: string): Promise<{ tabUrl?: string; thirdParty?: boolean }> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) return {};
    return { tabUrl: tab.url, thirdParty: new URL(initiator).hostname !== new URL(tab.url).hostname };
  } catch {
    return {};
  }
}

/** Fire-and-forget push to a specific tab telling its top-frame content script new media was
 * found — shows the floating icon (docs/ROADMAP.md §6.1, now utils/ui-compositor.ts's `icon`), which opens the
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
    // segments (fetched later by the download engine, not here) are typically same-CDN-host.
    if (entry.requestHeaders) {
      await syncHeaderReplayRule(new URL(entry.url).hostname, entry.requestHeaders);
    }
    const manifest = parseM3u8(await (await fetch(entry.url)).text(), entry.url);
    if (manifest.kind === 'master') {
      await updateDetectedMedia(entry.id, { variants: manifest.variants }, cache);
    } else if (manifest.kind === 'media') {
      // Segment URLs themselves are re-fetched+parsed by the download engine (docs/ROADMAP.md
      // #5.3/§8.1) when the user actually clicks Download, not stashed here (hundreds of URLs per
      // stream, and stale the moment the manifest rotates, unlike the count).
      await updateDetectedMedia(entry.id, { segmentCount: manifest.segments.length, encrypted: manifest.encrypted }, cache);
    }
    // {kind:'unknown'} — silent no-op, same as a fetch failure below.
  } catch {
    // Fetch failure or unparsable manifest — graceful no-op, same "partial result over failure"
    // posture as fetch-images'/crawlSite's per-item skip.
  }
}

/** docs/ROADMAP.md §10.4 — shared by the report-main-world-media/report-dom-media listeners below:
 * validates (never trusts the content-script shim to have already filtered), builds the
 * `DetectedMedia` record — now including `tabUrl` when the sender's tab is known — stores it, and
 * kicks off auto-inspect for a newly-added stream. `tabUrl` is what fixes cross-origin-iframe
 * entries being invisible to the Side Panel's per-tab scoping (docs/ROADMAP.md §6.3/§6.4): `pageUrl`
 * alone is the reporting FRAME's own origin, not the tab's top-level one, and the two disagree
 * exactly for a nested/cross-origin iframe — the case §10.4 was opened for. */
async function persistDetectedMedia(url: string, pageUrl: string | undefined, tabUrl: string | undefined, cache: CacheService): Promise<void> {
  if (isJunkRequest(url, pageUrl)) return;
  const kind = classifyMediaUrl(url);
  if (!kind) return;
  const media: DetectedMedia = {
    id: crypto.randomUUID(),
    url,
    kind,
    detectedAt: new Date().toISOString(),
    ...(pageUrl ? { pageUrl } : {}),
    ...(tabUrl !== undefined ? { tabUrl } : {}),
    ...(looksLikeSignedUrl(url) ? { expiring: true } : {}),
  };
  if (await addDetectedMedia(media, cache) && kind === 'stream') {
    void inspectStreamEntry(media, cache);
  }
}

// docs/ROADMAP.md §6.3, extended §10.4 — a standalone listener (not `run()`'s Bus dispatch) so it
// can peek at `sender.tab` directly, which the generic BusService.on() handler shape doesn't
// expose (same reasoning as the report-dom-media notify-only listener this replaces). Two things
// need `sender.tab`: (a) the tabId, to notify the top frame's floating icon when the detection
// happened in a nested/cross-origin iframe (dom-media-observer.ts runs in every frame,
// frame-media-observer.ts's all_frames:true — chrome.tabs.sendMessage broadcasts to every frame
// with no frameId, so only content-scripts/index.ts's top-frame instance is listening for
// `synapse:media-found`); (b) the tab's own url, to record on the entry as `tabUrl` — `sender.tab`
// is a full `chrome.tabs.Tab` (host_permissions already cover `<all_urls>`), no extra
// `chrome.tabs.get` round trip needed. Uses `chromeStorageCache` directly, not `ctx.services.cache`
// — this listener has no Kernel-provided `ctx` at all, same reasoning as `handleObservedRequest`'s
// doc comment below.
chrome.runtime.onMessage.addListener((message: { event?: string; payload?: ReportDomMediaCommand } | undefined, sender) => {
  if (message?.event !== 'network-sniffer' || message.payload?.op !== 'report-dom-media') return;
  if (sender.tab?.id) notifyTabMediaFound(sender.tab.id);
  const items = message.payload.items;
  void (async () => {
    // Re-validates server-side rather than trusting the content script's own filtering — same
    // "never trust the shim to self-limit" posture rpc-handler.ts already documents.
    if (!(await isModuleActive('network-sniffer'))) return;
    for (const item of items) {
      await persistDetectedMedia(item.url, item.pageUrl, sender.tab?.url, chromeStorageCache);
    }
  })();
});

// docs/ROADMAP.md §10.4 — report-main-world-media's own counterpart to the listener above. No
// notify call here (unlike report-dom-media): this source is registered top-frame-only
// (content-scripts/index.ts, matching where the MAIN-world script itself runs), so the sender is
// already the tab's own top frame — it shows its own floating icon directly, no round trip needed
// (see content-scripts/index.ts's doc comment on this). `tabUrl` is added for the same consistency
// reasoning as report-dom-media, even though for this always-top-frame source it's expected to
// equal `pageUrl` in practice.
chrome.runtime.onMessage.addListener((message: { event?: string; payload?: ReportMainWorldMediaCommand } | undefined, sender) => {
  if (message?.event !== 'network-sniffer' || message.payload?.op !== 'report-main-world-media') return;
  const { url, pageUrl } = message.payload;
  void (async () => {
    if (!(await isModuleActive('network-sniffer'))) return;
    await persistDetectedMedia(url, pageUrl, sender.tab?.url, chromeStorageCache);
  })();
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
    // shim to self-limit" posture as the report-dom-media/report-main-world-media listeners below.
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
export const NetworkSnifferModule: Module<CollectionCommand<DetectedMedia> | undefined, void> = {
  id: 'network-sniffer',
  label: 'Media Sniffer',
  description: 'Passively detects video/audio/stream URLs requested by pages you visit, and lets you download them.',
  needs: ['bus', 'cache'],
  // docs/ROADMAP.md #4.2 — this Module also pushes an on-page floating widget (utils/
  // ui-compositor.ts) when it detects media, instead of only surfacing results in the Dashboard.
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
    // `kind:'stream'` sends a `synapse:download-engine-command` START instead (`engineKinds`,
    // docs/ROADMAP.md §8.1 — the HLS engine runs headless in a singleton Offscreen Document, no Tab
    // opens anymore) — no-op/errors gracefully on a URL that isn't an HLS media playlist (the
    // engine's own error event). Manifest inspection itself is no longer a user-facing rowAction
    // (docs/ROADMAP.md §6.3 — auto-inspect runs automatically on every `stream`-kind detection now,
    // see inspectStreamEntry above). Reads `downloadUrl` (below), not `url` — a master-playlist
    // entry's OWN `url` is just the manifest listing other resolutions, not downloadable/mergeable
    // on its own since §6.3 folded its variants into `variants` instead of separate rows;
    // `downloadUrl` resolves to the first variant automatically (same default the Side Panel's own
    // `<select>` starts on) — the `variantsField` column below lets a row pick a different
    // resolution instead of that default.
    rowActions: [
      {
        kind: 'smart-download',
        label: 'Download',
        urlField: 'downloadUrl',
        kindField: 'kind',
        engineKinds: ['stream'],
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
        key: 'expiring',
        label: 'Link expires?',
        hint: 'docs/ROADMAP.md #7.4 — this URL\'s query string looks signed/time-limited (S3-style presigned URL, CDN token-auth, etc.) — download it soon, not a reliable indicator on its own',
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
    collapseVariantShadowedEntries(await listDetectedMedia()).map((m) => ({
      ...m,
      downloadUrl: m.variants?.[0]?.url ?? m.url,
      variantLinks: m.variants?.map((v, i) => ({ url: v.url, label: describeResolution(v.resolution, `Option ${i + 1}`) })),
    })) as unknown as Record<string, unknown>[],
  async run(command, ctx) {
    if (!(await isModuleActive('network-sniffer'))) {
      // Deliberately does NOT call teardownNetworkObserver() — the chrome.webRequest listener is
      // installed once at service-worker startup and stays installed (see installNetworkSniffing at
      // the bottom of this file); deactivating the Module only makes its callback inert. Removing
      // and re-adding the listener from here is precisely the pattern that made detection unreliable.
      setSniffingActive(false);
      if (await isMainWorldScriptRegistered(MAIN_WORLD_SCRIPT_ID)) {
        await unregisterMainWorldScript(MAIN_WORLD_SCRIPT_ID);
      }
      return;
    }

    setSniffingActive(true);

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

    // 'report-main-world-media'/'report-dom-media' (docs/ROADMAP.md §10.4) are handled by their
    // own standalone chrome.runtime.onMessage listeners above, not here — see persistDetectedMedia
    // and the listeners registered right after it for why (need `sender.tab`, which the generic
    // BusService.on() handler shape this run() is invoked through doesn't expose).
  },
};

/**
 * docs/ROADMAP.md #4 — the detection callback, hoisted out of `run()` so the chrome.webRequest
 * listener can be installed at service-worker STARTUP rather than on a bus event.
 *
 * Why that matters: an MV3 service worker is killed after ~30s idle, and `chrome.webRequest`
 * listeners do not survive it — they must be re-added every time the worker starts. Registering
 * them from inside `run()` meant the listener only came back after a chain of asynchronous steps
 * (`kernel.run()` resolving → a `chromeRuntimeBus` emit round trip → an `await isModuleActive()`
 * storage read). A page load is exactly what wakes the worker, so its media requests raced that
 * chain and routinely lost — and a request that arrives before the listener exists produces NO
 * record anywhere, not even in `recentRejections`, which is precisely the "the URL is in DevTools
 * but nowhere in Synapse, and the rejection log doesn't mention it either" symptom this fixes.
 *
 * Uses `chromeStorageCache` directly rather than `ctx.services.cache`: there is no `ctx` at startup,
 * and that singleton is what the ServiceInjector resolves 'cache' to anyway (kernel/module.ts), so
 * this is the same store the Module's own paths write to, not a second one.
 */
function handleObservedRequest(req: ObservedRequest): void {
  const syncKind = classifyDetection(req);
  if (!syncKind && !shouldProbeMagicBytes(req)) {
    recordRejection(req);
    return;
  }
  void (async () => {
    // docs/ROADMAP.md #7.2 — only reached when classifyDetection couldn't tell from URL/Content-Type
    // alone; the probe fetch is what turns a genuinely blind request into a classified one (or
    // leaves it undetected, same as before this rescue path existed).
    const kind = syncKind ?? (await probeMagicBytesKind(req.url));
    if (!kind) {
      recordRejection(req, 'magic-bytes probe ran but did not recognize the first bytes as media');
      return;
    }
    // Only computable when the observer gave us an initiator — the only source with a tabId+initiator
    // in hand (docs/ROADMAP.md #4.1's third-party signal).
    const { tabUrl, thirdParty } = req.initiator ? await describeTabContext(req.tabId, req.initiator) : {};
    // exactOptionalPropertyTypes: only include a field when actually available, never `undefined`.
    const media: DetectedMedia = {
      id: crypto.randomUUID(),
      url: req.url,
      kind,
      detectedAt: new Date().toISOString(),
      ...(req.initiator ? { pageUrl: req.initiator } : {}),
      ...(tabUrl !== undefined ? { tabUrl } : {}),
      ...(thirdParty !== undefined ? { thirdParty } : {}),
      ...(looksLikeSignedUrl(req.url) ? { expiring: true } : {}),
      // docs/ROADMAP.md #7.1 — only the webRequest source ever has the original request's own headers
      // in hand (report-dom-media/report-main-world-media never see them).
      ...(req.requestHeaders && Object.keys(req.requestHeaders).length > 0 ? { requestHeaders: req.requestHeaders } : {}),
    };
    // docs/ROADMAP.md #4.2 — only push the floating-icon notice on a genuine new detection (not a
    // repeat request for an already-known URL), same "don't spam a chatty page" philosophy as the
    // store's own dedupe/cap.
    if (await addDetectedMedia(media, chromeStorageCache)) {
      notifyTabMediaFound(req.tabId);
      if (kind === 'stream') void inspectStreamEntry(media, chromeStorageCache);
    }
  })();
}

/**
 * `undefined` = not yet known, which is a THIRD state and not the same as inactive: at startup the
 * listener is live before the activation flag has been read back, and requests arriving in that
 * window are the ones that were being lost. They're held here and replayed once the answer arrives,
 * so the fix isn't merely "register earlier" (which would still race) but "never drop a request just
 * because the answer hasn't landed yet". Bounded — a page that fires more than this while the flag
 * resolves is already past the point where the tail matters.
 */
let sniffingActive: boolean | undefined;
const pendingObserved: ObservedRequest[] = [];
const MAX_PENDING_OBSERVED = 50;

function setSniffingActive(active: boolean): void {
  sniffingActive = active;
  const buffered = pendingObserved.splice(0, pendingObserved.length);
  if (active) for (const req of buffered) handleObservedRequest(req);
}

/**
 * Installed unconditionally at module-evaluation time. `background-modules.ts` pulls every
 * `background/modules/*\/index.ts` in via an EAGER `import.meta.glob`, so this runs synchronously
 * during service-worker startup — the only point at which an MV3 `chrome.webRequest` listener is
 * guaranteed to catch the requests that woke the worker.
 *
 * Kept installed even while the Module is deactivated (the callback just returns): the cost is one
 * no-op call per observed request, against the alternative of re-entering the remove/re-add cycle
 * that caused the lost detections in the first place.
 */
/**
 * Raw, UNFILTERED record of what chrome.webRequest actually handed this module, written before any
 * gating or classification.
 *
 * `recentRejections` cannot answer the question that keeps coming up — "the URL is in DevTools but
 * nowhere in Synapse" — because it only records requests that reached the reject path AND looked
 * media-shaped. An empty result there is ambiguous between three very different states: the listener
 * never fired, the module is inactive, or the request was seen and dropped. This distinguishes them,
 * and is deliberately unconditional: a diagnostic that shares the filters of the thing it is
 * diagnosing cannot falsify it.
 */
const MAX_OBSERVED_URLS = 300;
const observedUrls: { url: string; resourceType: string; tabId: number }[] = [];
const snifferStats = { observed: 0, buffered: 0, droppedInactive: 0, handled: 0 };

ensureNetworkObserver((req) => {
  snifferStats.observed++;
  observedUrls.push({ url: req.url, resourceType: req.resourceType, tabId: req.tabId });
  if (observedUrls.length > MAX_OBSERVED_URLS) observedUrls.shift();

  if (sniffingActive === false) {
    snifferStats.droppedInactive++;
    return;
  }
  if (sniffingActive === undefined) {
    snifferStats.buffered++;
    if (pendingObserved.length < MAX_PENDING_OBSERVED) pendingObserved.push(req);
    return;
  }
  snifferStats.handled++;
  handleObservedRequest(req);
});

// Debug-only handle, same posture as __synapseRejectedMedia. `active` is a getter so it reports the
// flag's value at read time rather than at install time (it is still `undefined` when this runs).
Object.defineProperty(globalThis, '__synapseSniffer', {
  value: {
    stats: snifferStats,
    observedUrls,
    rejected: recentRejections,
    get active() {
      return sniffingActive;
    },
  },
  configurable: true,
});

// Resolves the activation flag directly instead of waiting for the bus 'sync' that background/
// index.ts emits after kernel.run() — one storage read, started at startup, rather than a multi-step
// async chain. The bus sync still arrives later and is still what handles activation CHANGES; this
// only shortens the startup window during which requests have to be buffered above.
void isModuleActive('network-sniffer')
  .then(setSniffingActive)
  .catch(() => setSniffingActive(false));

// Rebuilds `streamStemsByDirectory` from streams already known, so a service-worker restart mid-
// playback doesn't start listing the current stream's segments as standalone videos. A master's
// `variants` matter as much as the entries themselves — the segments live next to the VARIANT
// playlist, which is often on a different host from the master that lists it.
void listDetectedMedia()
  .then((items) => {
    for (const item of items) {
      if (item.kind === 'stream') rememberStreamManifest(item.url);
      for (const variant of item.variants ?? []) rememberStreamManifest(variant.url);
    }
  })
  .catch(() => {});
