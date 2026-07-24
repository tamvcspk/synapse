/**
 * Generic background-only network *observation* mechanism built on chrome.webRequest (Environment
 * SDK — see the sdk-layers skill's mechanism-vs-policy rule; docs/ROADMAP.md #4). Unlike
 * debugger-network-interceptor.ts/dnr-network-rules.ts (which intercept/modify requests),
 * chrome.webRequest.onBeforeRequest here is read-only — this file has zero opinion on what counts
 * as "media", it just reports every observed request URL to the caller's `onDetected` callback.
 *
 * Filtered to resource types where a direct media/stream URL is actually expected — skips
 * `script`/`stylesheet`/`image`/`font`/etc. at the browser level rather than filtering them out in
 * JS after the fact, which cuts down event volume for busy pages.
 */

export interface ObservedRequest {
  url: string;
  tabId: number;
  /** The requesting page's origin, when Chrome provides one — used as a cheap stand-in for "which
   * page was this found on" without an extra async chrome.tabs.get() round trip per event. */
  initiator?: string;
}

let installed = false;
let currentOnDetected: ((req: ObservedRequest) => void) | null = null;

function onBeforeRequest(details: chrome.webRequest.WebRequestBodyDetails): void {
  if (details.tabId < 0) return; // negative tabId = not associated with a tab (e.g. extension's own requests)
  // exactOptionalPropertyTypes: only include `initiator` when Chrome actually provided one, rather
  // than assigning `undefined` to an optional field explicitly.
  currentOnDetected?.(
    details.initiator
      ? { url: details.url, tabId: details.tabId, initiator: details.initiator }
      : { url: details.url, tabId: details.tabId },
  );
}

/** Idempotent: safe to call every time the caller's Module re-syncs — always refreshes the
 * `onDetected` closure in place, only installs the actual listener the first time. */
export function ensureNetworkObserver(onDetected: (req: ObservedRequest) => void): void {
  currentOnDetected = onDetected;
  if (installed) return;
  installed = true;

  chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, {
    urls: ['<all_urls>'],
    types: ['media', 'xmlhttprequest', 'object', 'other'],
  });
}

/** Removes the listener — call once the Module is no longer active. */
export function teardownNetworkObserver(): void {
  currentOnDetected = null;
  if (!installed) return;
  installed = false;

  chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
}
