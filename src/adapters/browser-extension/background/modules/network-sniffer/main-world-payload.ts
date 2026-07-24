import { classifyMediaUrl } from '../../../../../shared/media-url-matcher';
import { createMainWorldChannel } from '../../../utils/main-world/event-channel';
import { installNetworkInterceptor, type InterceptDecision } from '../../../utils/main-world/network-interceptor';
import { MAIN_WORLD_REPORT_CHANNEL_ID } from './constants';

/**
 * MAIN-world composition root for network-sniffer's third detection source (docs/ROADMAP.md #4.1)
 * — owned by the Module (colocated in its folder) even though it's a separate build entry, per the
 * main-world-interceptor skill. Zero chrome.* here — dynamically registered by
 * background/modules/network-sniffer/index.ts via utils/main-world-injector.ts, built via the
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
 */
const channel = createMainWorldChannel<{ url: string }>(MAIN_WORLD_REPORT_CHANNEL_ID);

installNetworkInterceptor(({ url }): InterceptDecision => {
  if (classifyMediaUrl(url)) channel.dispatch({ url });
  return { intercept: false };
});
