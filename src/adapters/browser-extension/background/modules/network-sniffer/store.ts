import type { CacheService } from '../../../../../kernel/module';
import { chromeStorageCache } from '../../services/cache';

export interface DetectedMedia {
  id: string;
  url: string;
  kind: 'video' | 'audio' | 'stream';
  /** The page the request was seen on (webrequest-media-observer.ts's `initiator`) — absent for
   * requests Chrome doesn't attribute to a page origin. */
  pageUrl?: string;
  /** ISO timestamp — display-only, not used for ordering (storage array order is insertion order). */
  detectedAt: string;
  /** docs/ROADMAP.md #4.1 — best-effort signal that this request's initiating document isn't the
   * tab's own top-level page (e.g. a third-party ad iframe). A LABEL, not a filter — a legitimate
   * video is often served from a different-origin CDN too, so this is never used to exclude
   * anything. `undefined` means unknown (only ever computed for the `webRequest`-sourced path,
   * which is the only source with a tabId+initiator in hand), not "known first-party". */
  thirdParty?: boolean;
  /** The TOP-LEVEL url of the tab this request was seen in — distinct from `pageUrl`, which is the
   * initiating frame's origin. For media loaded by a cross-origin iframe the two disagree, and only
   * this one answers "which tab is this on": a `<video>` inside an ad/embed iframe reports
   * `pageUrl: https://<iframe-origin>` while the user is looking at a completely different host.
   * The Side Panel's per-tab scoping (docs/ROADMAP.md §6.3) compared `pageUrl`'s origin against the
   * active tab's and therefore hid every one of those entries — detected, stored, and invisible.
   * docs/ROADMAP.md §10.4 — all three detection sources (`webRequest`, `report-main-world-media`,
   * `report-dom-media`) now set this, read from `chrome.runtime.MessageSender.tab.url` in a
   * standalone listener that isn't routed through the generic Bus (`index.ts`'s
   * `persistDetectedMedia` and its callers) — previously only `webRequest` had a tabId in hand at
   * all. Still absent when the tab's url genuinely couldn't be read (chrome:// page, tab closed
   * between detection and lookup, or the message didn't originate from a tab). */
  tabUrl?: string;
  /** docs/ROADMAP.md #7.4 — best-effort signal that this URL's query string carries a signed/expiry
   * key (S3-style presigned URL, CDN token-auth, etc.) — see shared/signed-url-detector.ts. A LABEL,
   * not a filter (same reasoning as `thirdParty` above): a legitimate video being served behind a
   * signed URL is completely normal. Computed for every detection source (unlike `thirdParty`, this
   * is a pure string check with no tabId/initiator needed). */
  expiring?: boolean;
  /** Only set on a `kind: 'stream'` entry that was itself detected as a single, already-resolved
   * media/variant playlist (not a master listing other resolutions) — a master's variants live in
   * `variants` below instead, not as their own entries with this field (docs/ROADMAP.md §6.3). */
  resolution?: string;
  /** Set on a `kind: 'stream'` entry once auto-inspected and determined to be a media/variant
   * playlist (not a master listing other resolutions) — segment count alone, not a downloadable
   * file (see docs/ROADMAP.md #5.3 for why turning this into one is its own, much larger, feature). */
  segmentCount?: number;
  /** Set alongside `segmentCount` — a `#EXT-X-KEY:METHOD=...` other than `NONE` was present, i.e.
   * DRM (Widevine/EME). #5.3's download+remux flow must refuse these outright rather than produce
   * a silently-corrupt file. */
  encrypted?: boolean;
  /** docs/ROADMAP.md §6.3 — set on a master-playlist `kind:'stream'` entry once auto-inspected
   * (index.ts's `inspectStreamEntry`). Each variant is its own resolution's media-playlist URL —
   * no longer a separately-tracked `DetectedMedia` row per resolution (that was #5.1's original
   * behavior, replaced so one real video is one list item in the Side Panel, not N). */
  variants?: { url: string; resolution?: string }[];
  /** docs/ROADMAP.md #7.1 — a small allowlisted subset of the ORIGINAL page request's own headers
   * (`referer`/`origin`/`user-agent`/`range`, lowercase keys — see header-replay-rules.ts's
   * REPLAYABLE_HEADER_NAMES), captured so Synapse's own later `fetch()` of this URL (or its
   * segments) can replay them via a session DNR rule when a CDN hotlink-protects on them.
   * Deliberately never `Cookie`/`Authorization` — see header-replay-rules.ts's doc comment for why.
   * Only ever set on the `webRequest`-sourced detection path (the only source with the original
   * request's headers in hand). */
  requestHeaders?: Record<string, string>;
}

const DETECTED_MEDIA_STORAGE_KEY = 'synapse:network-sniffer:detected-media';
// Same safety-cap philosophy as MAX_CRAWL_PAGES/MAX_IMAGE_BYTES elsewhere (docs/ROADMAP.md #1) —
// a long browsing session shouldn't grow this list unboundedly.
const MAX_DETECTED_ITEMS = 200;

/**
 * CacheService-backed CRUD for DetectedMedia — module-owned persistence, routed through the
 * Kernel's 'cache' capability, same shape as http-error-mocker/mock-config-store.ts.
 * listCollection() has no ctx (kernel/module.ts), so it defaults to the same chromeStorageCache
 * singleton the ServiceInjector itself resolves to.
 */
export async function listDetectedMedia(cache: CacheService = chromeStorageCache): Promise<DetectedMedia[]> {
  const stored = await cache.get(DETECTED_MEDIA_STORAGE_KEY);
  return (stored as DetectedMedia[] | undefined) ?? [];
}

/** Dedupes by `url` (skip entirely if already present — repeat requests for the same resource are
 * common) and evicts the oldest entries once the list exceeds MAX_DETECTED_ITEMS. Returns whether
 * `media` was actually a new insertion — docs/ROADMAP.md #4.2's float-widget push only fires on a
 * genuine new detection, not on every repeat request for an already-known URL. */
export async function addDetectedMedia(media: DetectedMedia, cache: CacheService = chromeStorageCache): Promise<boolean> {
  const existing = await listDetectedMedia(cache);
  if (existing.some((m) => m.url === media.url)) return false;

  const next = [...existing, media];
  const overflow = next.length - MAX_DETECTED_ITEMS;
  if (overflow > 0) next.splice(0, overflow);

  await cache.set(DETECTED_MEDIA_STORAGE_KEY, next);
  return true;
}

export async function removeDetectedMedia(id: string, cache: CacheService = chromeStorageCache): Promise<void> {
  const existing = await listDetectedMedia(cache);
  await cache.set(DETECTED_MEDIA_STORAGE_KEY, existing.filter((m) => m.id !== id));
}

/**
 * docs/ROADMAP.md §6.3's "one real video = one item" only holds for resolutions a MASTER playlist
 * itself lists — a page's own player very often ALSO requests one or more of those exact variant
 * playlist URLs directly (adaptive-bitrate switching), which `chrome.webRequest` sees as just another
 * unrelated `.m3u8` request and records as its OWN top-level entry — there's no way for the detector
 * to know in the moment that a URL it just saw is already nested inside another entry's `variants`.
 * A display-time filter, not a storage change: hides any entry whose `url` matches a variant URL
 * already known on ANOTHER entry, so the master's resolution `<select>` is the only place that
 * resolution shows up. Both the Side Panel and the Dashboard's Management View read through this
 * (`listDetectedMedia()` itself stays raw/unfiltered — `addDetectedMedia`'s own url-dedupe check
 * needs the untouched list, not this display view, or a variant hidden here would look "new" again
 * and get re-inserted). Self-correcting if the master's own auto-inspect (`inspectStreamEntry`)
 * hasn't populated `variants` yet at read time — the variant shows up standalone for one render,
 * then collapses in on the next storage-change re-render once inspection finishes.
 */
/**
 * Variant shadowing is matched on origin+pathname, NOT the full URL string, because the two sides
 * systematically disagree about the query string: `variants` holds the URI exactly as the master
 * playlist WROTE it (usually bare), while the entry recorded for the page player's own request holds
 * the URL as it was actually SENT — and a player that appends a per-session token to each variant it
 * opens (real example: a master carrying `#EXT-X-MOUFLON:PSCH:v2:<key>` tags, whose player then
 * requests `..._480p.m3u8?psch=v2&pkey=<key>`) makes those two strings differ for what is one
 * playlist. Exact matching silently collapsed nothing on such a stream — i.e. it failed precisely
 * when the list is most cluttered. The tradeoff (two genuinely distinct streams differing ONLY in
 * query string would now collapse into one) isn't a shape HLS renditions take: the path names the
 * rendition.
 */
function variantIdentity(url: string): string {
  try {
    const { origin, pathname } = new URL(url);
    return `${origin}${pathname}`;
  } catch {
    return url; // unparsable — fall back to exact matching rather than dropping the entry entirely
  }
}

export function collapseVariantShadowedEntries(items: DetectedMedia[]): DetectedMedia[] {
  // The URL each variant path was ACTUALLY requested with, harvested from the standalone entries
  // this function is about to hide. A master playlist writes its variant URIs bare, but some players
  // append a per-session token before opening one — real example, an `#EXT-X-MOUFLON:PSCH:v2:<key>`
  // master whose player requests `..._480p.m3u8?psch=v2&pkey=<key>`, where the bare URI alone is
  // rejected by the CDN. Synapse already observed the working URL (that IS the standalone entry);
  // without this it threw that away and kept only the master's unusable copy. Newest wins — a
  // rotating token's freshest sighting is the one most likely to still be valid.
  //
  // Deliberately general: nothing here knows what a token looks like, only that an observed request
  // beats a manifest's transcription of the same path. Note the token rides on the VARIANT URL only;
  // segment URIs inside that playlist resolve against it via `new URL()`, which drops the query per
  // URL semantics — correct for a stream whose segments carry their own signatures (this one does),
  // but not a general solution for a CDN that needs the same token on every segment.
  const observedByIdentity = new Map<string, string>();
  for (const item of items) {
    if (item.variants?.length) continue; // a master's own URL is not a sighting of one of its variants
    observedByIdentity.set(variantIdentity(item.url), item.url);
  }

  const knownVariantUrls = new Set<string>();
  for (const item of items) {
    for (const v of item.variants ?? []) knownVariantUrls.add(variantIdentity(v.url));
  }

  return items
    // An entry that lists variants is a master — never hide it, even if its own URL normalizes to
    // one of its variants'. Defensive: that would erase the only entry carrying the resolution picker.
    .filter((item) => (item.variants?.length ? true : !knownVariantUrls.has(variantIdentity(item.url))))
    .map((item) => {
      if (!item.variants?.length) return item;
      const variants = item.variants.map((v) => {
        const observed = observedByIdentity.get(variantIdentity(v.url));
        return observed !== undefined && observed !== v.url ? { ...v, url: observed } : v;
      });
      return variants.some((v, i) => v !== item.variants![i]) ? { ...item, variants } : item;
    });
}

/** docs/ROADMAP.md #5.1 — patches an existing entry in place (e.g. Inspect writing back
 * `segmentCount`/`encrypted` after fetching a media/variant playlist). No-op if `id` isn't found
 * (entry dismissed between the Inspect click and this write finishing). */
export async function updateDetectedMedia(
  id: string,
  patch: Partial<DetectedMedia>,
  cache: CacheService = chromeStorageCache,
): Promise<void> {
  const existing = await listDetectedMedia(cache);
  await cache.set(
    DETECTED_MEDIA_STORAGE_KEY,
    existing.map((m) => (m.id === id ? { ...m, ...patch } : m)),
  );
}
