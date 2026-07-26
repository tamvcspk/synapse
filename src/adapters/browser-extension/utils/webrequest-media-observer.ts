/**
 * Generic background-only network *observation* mechanism built on chrome.webRequest (Environment
 * SDK — see the sdk-layers skill's mechanism-vs-policy rule; docs/ROADMAP.md #4). Unlike
 * debugger-network-interceptor.ts/dnr-network-rules.ts (which intercept/modify requests),
 * chrome.webRequest.onHeadersReceived here is read-only — this file has zero opinion on what
 * counts as "media", it just reports every observed request's URL/resourceType/Content-Type to the
 * caller's `onDetected` callback.
 *
 * Filtered to resource types where a direct media/stream URL is actually expected — skips
 * `script`/`stylesheet`/`image`/`font`/etc. at the browser level rather than filtering them out in
 * JS after the fact, which cuts down event volume for busy pages.
 *
 * Uses `onHeadersReceived` (not `onBeforeRequest`) specifically so `contentType` is available —
 * docs/ROADMAP.md #4.1's junk-URL filtering needs the server-confirmed Content-Type, not just the
 * request URL, to trust anything outside Chrome's own `'media'` resource-type classification. Still
 * non-blocking (`extraInfoSpec` only has `'responseHeaders'`, no `'blocking'`) — same posture as
 * before, no new permission needed.
 *
 * docs/ROADMAP.md #7.1 adds a second, still non-blocking listener (`onSendHeaders`) purely to read
 * a few of the request's own headers before it goes out — no `'blocking'` here either, this file
 * still only ever observes.
 */

import { capCapturedHeaders, isReplayableHeader } from './header-replay-rules';

export interface ObservedRequest {
  url: string;
  tabId: number;
  /** The requesting page's origin, when Chrome provides one — used as a cheap stand-in for "which
   * page was this found on" without an extra async chrome.tabs.get() round trip per event. */
  initiator?: string;
  /** How Chrome itself classified this fetch — `'media'` is high-trust (a real <video>/<audio>
   * network fetch); `'xmlhttprequest'`/`'object'`/`'other'` is the noisy bucket where a URL merely
   * looking like media isn't enough on its own (docs/ROADMAP.md #4.1). */
  resourceType: chrome.webRequest.ResourceType;
  /** The response's `Content-Type` header, when present — absent for requests that errored out
   * before headers arrived, or that genuinely omitted the header. */
  contentType?: string;
  /** docs/ROADMAP.md #7.1 — this request's OWN headers, minus the ones that are unsafe or
   * meaningless to replay (credentials, conditional/ranged, transport — see header-replay-rules.ts's
   * `isReplayableHeader`), worth replaying when Synapse later re-fetches this URL itself (a lot of
   * CDN media hotlink-protects on exactly these). Absent when the request had none of them, or
   * `onSendHeaders` never fired for it. */
  requestHeaders?: Record<string, string>;
}

let installed = false;
let currentOnDetected: ((req: ObservedRequest) => void) | null = null;

// docs/ROADMAP.md #7.1 — onSendHeaders (request-side) necessarily fires before onHeadersReceived
// (response-side) for the same requestId, so this map is only ever read-then-deleted by the time
// the matching onHeadersReceived call reports the detection. The timeout is just a leak guard for a
// request that errors out or gets blocked before a response ever arrives.
const pendingRequestHeaders = new Map<string, Record<string, string>>();
const PENDING_HEADERS_TTL_MS = 30_000;

function extractContentType(headers: chrome.webRequest.HttpHeader[] | undefined): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === 'content-type')?.value;
}

function extractReplayableHeaders(headers: chrome.webRequest.HttpHeader[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const h of headers ?? []) {
    const name = h.name.toLowerCase();
    if (h.value && isReplayableHeader(name)) result[name] = h.value;
  }
  return capCapturedHeaders(result);
}

function onSendHeaders(details: chrome.webRequest.WebRequestHeadersDetails): void {
  if (details.initiator === EXTENSION_ORIGIN) return; // mirrors onHeadersReceived's own guard
  const headers = extractReplayableHeaders(details.requestHeaders);
  if (Object.keys(headers).length === 0) return;
  pendingRequestHeaders.set(details.requestId, headers);
  setTimeout(() => pendingRequestHeaders.delete(details.requestId), PENDING_HEADERS_TTL_MS);
}

/** This extension's own origin. A request Synapse itself issued must never be reported as a new
 * detection: the Merge page downloads segments from a real tab (positive tabId, so the `tabId < 0`
 * guard below does NOT catch it), and every one of those fetches was coming back in as its own
 * `video` entry — an HLS download of N segments polluted the list with N bogus rows naming the
 * stream Synapse was in the middle of saving. Same for `inspectStreamEntry`'s manifest fetch. */
const EXTENSION_ORIGIN = `chrome-extension://${chrome.runtime.id}`;

function onHeadersReceived(details: chrome.webRequest.WebResponseHeadersDetails): void {
  // No `tabId < 0` guard: that used to stand in for "the extension's own requests", a job
  // EXTENSION_ORIGIN now does precisely. What it ALSO discarded, silently, was every request a page's
  // own Service Worker issued — Chrome attributes those to no tab — which for an SW-proxied player is
  // the entire media stream. Reporting them costs nothing: `notifyTabMediaFound(-1)` and
  // `isThirdPartyInitiator(-1, ...)` both already fail soft.
  if (details.initiator === EXTENSION_ORIGIN) return; // see EXTENSION_ORIGIN — Synapse's own fetches, not detections
  // exactOptionalPropertyTypes: only include `initiator`/`contentType` when actually provided,
  // rather than assigning `undefined` to an optional field explicitly.
  const req: ObservedRequest = { url: details.url, tabId: details.tabId, resourceType: details.type };
  if (details.initiator) req.initiator = details.initiator;
  const contentType = extractContentType(details.responseHeaders);
  if (contentType) req.contentType = contentType;
  const requestHeaders = pendingRequestHeaders.get(details.requestId);
  if (requestHeaders) {
    req.requestHeaders = requestHeaders;
    pendingRequestHeaders.delete(details.requestId);
  }
  currentOnDetected?.(req);
}

/** Idempotent: safe to call every time the caller's Module re-syncs — always refreshes the
 * `onDetected` closure in place, only installs the actual listener the first time. */
export function ensureNetworkObserver(onDetected: (req: ObservedRequest) => void): void {
  currentOnDetected = onDetected;
  if (installed) return;
  installed = true;

  // No `types` filter. The old one (`media`/`xmlhttprequest`/`object`/`other`) traded away the one
  // thing this mechanism cannot recover from: a resource type it excludes is dropped by the BROWSER,
  // so the callback never runs and nothing — not even the caller's rejection log — records that the
  // request existed. That turns any misclassification into an unfalsifiable "it just isn't detected",
  // which is exactly the state a `<video>` inside a cross-origin ad iframe left us in. Chrome's own
  // classification is not something to bet correctness on; filtering now happens in the policy layer
  // where a rejection is at least VISIBLE. The cost is a few hundred extra callback invocations per
  // page load, each a handful of string comparisons.
  chrome.webRequest.onHeadersReceived.addListener(onHeadersReceived, { urls: ['<all_urls>'] }, ['responseHeaders']);
  // 'extraHeaders' is required on Chrome to see Referer/Origin/User-Agent at all here — without it
  // these are silently withheld from onSendHeaders even though 'requestHeaders' is requested.
  chrome.webRequest.onSendHeaders.addListener(onSendHeaders, { urls: ['<all_urls>'] }, ['requestHeaders', 'extraHeaders']);
}

/** Removes the listener — call once the Module is no longer active. */
export function teardownNetworkObserver(): void {
  currentOnDetected = null;
  if (!installed) return;
  installed = false;

  chrome.webRequest.onHeadersReceived.removeListener(onHeadersReceived);
  chrome.webRequest.onSendHeaders.removeListener(onSendHeaders);
}
