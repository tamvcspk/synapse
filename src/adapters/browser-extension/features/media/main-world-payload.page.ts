import { classifyMediaUrl } from '../../../../shared/media-url-matcher';
import { createMainWorldChannel } from '../../utils/main-world/event-channel';
import { installNetworkInterceptor, type InterceptDecision } from '../../utils/main-world/network-interceptor';
import { installMediaSourceInterceptor } from './media-source-interceptor.page';
import { installHlsGlobalHook } from './hls-global-hook.page';
import {
  MAIN_WORLD_REPORT_CHANNEL_ID,
  MAIN_WORLD_CORRELATION_CHANNEL_ID,
  MAIN_WORLD_HLS_CORRELATION_CHANNEL_ID,
  HLS_CORRELATION_ATTRIBUTE,
} from './constants';

/**
 * MAIN-world composition root for network-sniffer's third detection source (docs/ROADMAP.md #4.1)
 * — owned by the Module (colocated in its folder) even though it's a separate build entry, per the
 * main-world-interceptor skill. Zero chrome.* here — dynamically registered by
 * features/media/network-sniffer.background.ts via utils/main-world-injector.ts, built via the
 * `?script&iife` resource import (see that skill for why `&module` breaks silently).
 *
 * Observe-only: `evaluate` always returns `{ intercept: false }`, never modifying a request — the
 * point is purely to see the URL a player library's own fetch()/XHR call targets. This exists
 * because chrome.webRequest (the primary detection mechanism) can only classify by URL extension or
 * a response's Content-Type header, and an MSE-based player (hls.js/dash.js, `<video
 * src="blob:...">`) that fetches its manifest via a plain JS call is exactly the case where a
 * server's imprecise/missing Content-Type would cause webRequest's stricter xmlhttprequest/other
 * filtering to miss it (docs/ROADMAP.md #4.1's Content-Type trust split) — watching the page's own
 * JS call sidesteps that entirely, since it never depends on what headers the server sends back.
 *
 * Verified-safe alongside http-error-mocker's own MAIN-world interceptor if both are active on the
 * same page: `installNetworkInterceptor` captures "whatever window.fetch/XHR currently is" at call
 * time, so two independently registered MAIN-world scripts chain correctly regardless of injection
 * order — each just wraps whatever the other left behind in the same MAIN-world JS realm.
 *
 * docs/ROADMAP.md #7.3 adds two more MAIN-world hooks alongside the fetch/XHR one above, both purely
 * for CORRELATION (which `<video>`/`<audio>` element a blob:-sourced MSE player's manifest URL
 * belongs to) — they don't detect any URL the fetch/XHR hook wouldn't already see and report, they
 * only make the badge-anchoring in dom-media-observer.content.ts precise per-element instead of a single
 * page-global guess: `installMediaSourceInterceptor` (generic, works for any MSE player) and
 * `installHlsGlobalHook` (narrower, exact, only fires when the page exposes `window.Hls`).
 */
const reportChannel = createMainWorldChannel<{ url: string }>(MAIN_WORLD_REPORT_CHANNEL_ID);
// docs/ROADMAP.md #7.3(a)
const correlationChannel = createMainWorldChannel<{ blobUrl: string; url: string }>(MAIN_WORLD_CORRELATION_CHANNEL_ID);
// docs/ROADMAP.md §7.3(a-hls) bugfix — see constants.ts's doc comment: the attribute write alone
// doesn't trigger dom-media-observer.content.ts's rescan, this explicit signal does.
const hlsCorrelationChannel = createMainWorldChannel<Record<string, never>>(MAIN_WORLD_HLS_CORRELATION_CHANNEL_ID);

// docs/ROADMAP.md #7.3(a) — a short ring buffer of recently classified media/manifest URLs, keyed
// only by recency, not by which MediaSource/player fetched it (no browser API links a fetch() call
// to the MediaSource that later consumes its response). installMediaSourceInterceptor's
// `addSourceBuffer` event below is the signal that "a player just committed to a codec for THIS
// MediaSource" — treating whichever URL was classified most recently at that moment as this
// MediaSource's own manifest/media URL narrows the correlation window from "anywhere on the page"
// (the old single page-global) to "around this specific player's own setup".
const RECENT_URL_WINDOW_MS = 5000;
let recentUrls: { url: string; at: number }[] = [];

function rememberRecentUrl(url: string): void {
  const now = Date.now();
  recentUrls.push({ url, at: now });
  recentUrls = recentUrls.filter((entry) => now - entry.at <= RECENT_URL_WINDOW_MS);
}

installNetworkInterceptor(({ url }): InterceptDecision => {
  if (classifyMediaUrl(url)) {
    reportChannel.dispatch({ url });
    rememberRecentUrl(url);
  }
  return { intercept: false };
});

const blobUrlByMediaSourceId = new Map<string, string>();

installMediaSourceInterceptor((event) => {
  if (event.blobUrl) blobUrlByMediaSourceId.set(event.mediaSourceId, event.blobUrl);
  if (event.mimeType) {
    const blobUrl = blobUrlByMediaSourceId.get(event.mediaSourceId);
    const url = recentUrls.at(-1)?.url;
    if (blobUrl && url) correlationChannel.dispatch({ blobUrl, url });
  }
});

// docs/ROADMAP.md #7.3(a-hls) — supplements (a) above with an EXACT pairing (no time-window
// guessing) when the page happens to expose `window.Hls` as a global. Tags the element directly via
// a data attribute rather than relaying a DOM reference across the MAIN/ISOLATED world boundary —
// see HLS_CORRELATION_ATTRIBUTE's doc comment in constants.ts.
installHlsGlobalHook(({ url, media }) => {
  media.setAttribute(HLS_CORRELATION_ATTRIBUTE, url);
  hlsCorrelationChannel.dispatch({});
});
