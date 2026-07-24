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
 */

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
}

let installed = false;
let currentOnDetected: ((req: ObservedRequest) => void) | null = null;

function extractContentType(headers: chrome.webRequest.HttpHeader[] | undefined): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === 'content-type')?.value;
}

function onHeadersReceived(details: chrome.webRequest.WebResponseHeadersDetails): void {
  if (details.tabId < 0) return; // negative tabId = not associated with a tab (e.g. extension's own requests)
  // exactOptionalPropertyTypes: only include `initiator`/`contentType` when actually provided,
  // rather than assigning `undefined` to an optional field explicitly.
  const req: ObservedRequest = { url: details.url, tabId: details.tabId, resourceType: details.type };
  if (details.initiator) req.initiator = details.initiator;
  const contentType = extractContentType(details.responseHeaders);
  if (contentType) req.contentType = contentType;
  currentOnDetected?.(req);
}

/** Idempotent: safe to call every time the caller's Module re-syncs — always refreshes the
 * `onDetected` closure in place, only installs the actual listener the first time. */
export function ensureNetworkObserver(onDetected: (req: ObservedRequest) => void): void {
  currentOnDetected = onDetected;
  if (installed) return;
  installed = true;

  chrome.webRequest.onHeadersReceived.addListener(
    onHeadersReceived,
    { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'object', 'other'] },
    ['responseHeaders'],
  );
}

/** Removes the listener — call once the Module is no longer active. */
export function teardownNetworkObserver(): void {
  currentOnDetected = null;
  if (!installed) return;
  installed = false;

  chrome.webRequest.onHeadersReceived.removeListener(onHeadersReceived);
}
