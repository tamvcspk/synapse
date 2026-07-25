/**
 * MAIN-world mechanism (Environment SDK — see the sdk-layers skill's mechanism-vs-policy rule) that
 * hooks `URL.createObjectURL`/`MediaSource.prototype.addSourceBuffer` to correlate a `blob:` object
 * URL to whichever manifest/media URL the page's own MediaSource-based player (hls.js, dash.js, a
 * custom player, ...) is actually streaming (docs/ROADMAP.md #7.3(a)).
 *
 * Assigns each `MediaSource` instance an opaque id purely so the caller can relate two separate
 * hook firings ("this MediaSource got blob: URL X" and "this MediaSource later added a
 * SourceBuffer") back to the same instance — a `WeakMap` can't be inspected by the caller directly.
 * Has zero opinion on which network URL that corresponds to; that decision (matching against
 * recently-observed fetch/XHR URLs) belongs entirely to the caller
 * (network-sniffer/main-world-payload.ts) — same mechanism/policy split as network-interceptor.ts.
 *
 * Deliberately doesn't try to bridge a `fetch()` call to the specific MediaSource that consumes its
 * response — no browser API exposes that link. What this DOES give the caller, that a page-global
 * "last observed URL" heuristic (the previous, coarser approach) can't: a stable id per MediaSource
 * instance, and the precise moment `addSourceBuffer` is called on THAT instance — a correlation
 * window scoped to one player's own setup instead of the whole page, even though it's still a
 * heuristic (time-window matching), not a hard link.
 */

export interface MediaSourceCorrelationEvent {
  mediaSourceId: string;
  /** Set only on the event fired right after this MediaSource's blob: URL is minted via
   * `URL.createObjectURL` — absent on the `addSourceBuffer` event below. */
  blobUrl?: string;
  /** Set only on the event fired from `addSourceBuffer` — the moment a player commits to a
   * codec/mime for this MediaSource, which the caller uses as "this is when I should look at what
   * URL was recently fetched." Absent on the `createObjectURL` event above. */
  mimeType?: string;
}

const mediaSourceIds = new WeakMap<MediaSource, string>();
let nextMediaSourceId = 1;

function idFor(mediaSource: MediaSource): string {
  let id = mediaSourceIds.get(mediaSource);
  if (id === undefined) {
    id = `synapse-ms-${nextMediaSourceId++}`;
    mediaSourceIds.set(mediaSource, id);
  }
  return id;
}

/** Patches `URL.createObjectURL`/`MediaSource.prototype.addSourceBuffer` in-place.
 * Idempotent-by-convention: call once. No-ops entirely on a page/context without a `MediaSource`
 * global (rare, but not guaranteed) rather than throwing — same "graceful absence" posture as the
 * rest of this Module's MAIN-world code. */
export function installMediaSourceInterceptor(onEvent: (event: MediaSourceCorrelationEvent) => void): void {
  if (typeof MediaSource === 'undefined') return;

  const originalCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = ((obj: MediaSource | Blob) => {
    const blobUrl = originalCreateObjectURL(obj);
    if (obj instanceof MediaSource) onEvent({ mediaSourceId: idFor(obj), blobUrl });
    return blobUrl;
  }) as typeof URL.createObjectURL;

  const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (this: MediaSource, mimeType: string): SourceBuffer {
    onEvent({ mediaSourceId: idFor(this), mimeType });
    return originalAddSourceBuffer.call(this, mimeType);
  };
}
