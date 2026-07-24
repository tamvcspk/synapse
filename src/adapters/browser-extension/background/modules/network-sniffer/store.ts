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
