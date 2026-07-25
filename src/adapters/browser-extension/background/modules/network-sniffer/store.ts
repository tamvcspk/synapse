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
export function collapseVariantShadowedEntries(items: DetectedMedia[]): DetectedMedia[] {
  const knownVariantUrls = new Set<string>();
  for (const item of items) {
    for (const v of item.variants ?? []) knownVariantUrls.add(v.url);
  }
  return items.filter((item) => !knownVariantUrls.has(item.url));
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
