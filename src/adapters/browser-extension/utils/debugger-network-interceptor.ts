import type { EvaluateRequest } from './main-world/network-interceptor';

/**
 * Generic background-only network interception mechanism built on chrome.debugger + CDP's Fetch
 * domain (Environment SDK — see the sdk-layers skill's mechanism-vs-policy rule; docs/ROADMAP.md
 * #2.6). Unlike utils/main-world/network-interceptor.ts (which patches window.fetch/XHR *inside*
 * the page, so a mocked request never touches the real network stack), this attaches Chrome's
 * remote debugging protocol to a tab and intercepts at the network-stack level — the same
 * mechanism DevTools itself uses. That's what makes mocked requests show up in the Network tab and
 * lets this mechanism catch every request type (images, scripts, downloads), not just fetch/XHR.
 *
 * No domain knowledge here — same `EvaluateRequest` contract as the MAIN-world interceptor, reused
 * as-is (see that file) rather than duplicated, so a caller can point either mechanism at the same
 * kind of business logic. Requires the 'debugger' permission (manifest.config.ts) and shows a
 * persistent "being debugged" banner on every attached tab — callers should only attach while at
 * least one rule actually needs this mechanism, and detach the moment none do.
 */

// CDP's Fetch domain isn't in @types/chrome (chrome.debugger.sendCommand's params/result are
// typed as a bare `Object`) — this is the minimal slice of its schema this file actually reads.
interface FetchRequestPausedEvent {
  requestId: string;
  request: { url: string; method: string; postData?: string };
}

let currentEvaluate: EvaluateRequest | null = null;
let installed = false;
const attachedTabs = new Set<number>();

/** UTF-8-safe replacement for a bare `btoa` (which throws on any char code > 255 — most fake JSON
 * bodies contain non-Latin1 text sooner or later). */
function toBase64Utf8(text: string): string {
  return btoa(unescape(encodeURIComponent(text)));
}

async function attachToTab(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    attachedTabs.add(tabId);
  } catch {
    // Expected for chrome://, the Web Store, or any tab DevTools already has open — chrome.debugger
    // can only ever attach to one debugger at a time. Not fatal: just means this tab stays unmocked.
  }
}

function onDebuggerEvent(source: chrome.debugger.Debuggee, method: string, params?: object): void {
  if (method !== 'Fetch.requestPaused' || source.tabId === undefined) return;
  const { requestId, request } = params as unknown as FetchRequestPausedEvent;

  const decision = currentEvaluate?.({ method: request.method, url: request.url, body: request.postData }) ?? { intercept: false };
  if (!decision.intercept) {
    void chrome.debugger.sendCommand({ tabId: source.tabId }, 'Fetch.continueRequest', { requestId });
    return;
  }

  const { response } = decision;
  const fulfill = () =>
    chrome.debugger.sendCommand({ tabId: source.tabId }, 'Fetch.fulfillRequest', {
      requestId,
      responseCode: response.status,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: toBase64Utf8(response.bodyText),
    });

  if (response.delayMs) setTimeout(fulfill, response.delayMs);
  else void fulfill();
}

function onTabCreated(tab: chrome.tabs.Tab): void {
  if (tab.id !== undefined) void attachToTab(tab.id);
}

function onTabUpdated(tabId: number, changeInfo: chrome.tabs.TabChangeInfo): void {
  // 'loading' fires at the start of a (re)navigation — attach before the page issues requests we'd
  // otherwise miss. A tab's debuggee is detached by the browser whenever it navigates away from
  // whatever was previously attached, so this can't just happen once at startup.
  if (changeInfo.status === 'loading') void attachToTab(tabId);
}

function onDebuggerDetach(source: chrome.debugger.Debuggee): void {
  if (source.tabId !== undefined) attachedTabs.delete(source.tabId);
}

/** Idempotent: safe to call every time the caller's config set changes — always refreshes the
 * `evaluate` closure in place, only (re-)installs listeners/attaches tabs the first time. */
export async function ensureDebuggerInterceptor(evaluate: EvaluateRequest): Promise<void> {
  currentEvaluate = evaluate;
  if (installed) return;
  installed = true;

  chrome.debugger.onEvent.addListener(onDebuggerEvent);
  chrome.debugger.onDetach.addListener(onDebuggerDetach);
  chrome.tabs.onCreated.addListener(onTabCreated);
  chrome.tabs.onUpdated.addListener(onTabUpdated);

  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter((tab) => tab.id !== undefined).map((tab) => attachToTab(tab.id!)));
}

/** Detaches from every tab and tears down listeners — call once no active MockConfig needs this
 * mechanism, so the "being debugged" banner disappears instead of lingering forever. */
export async function teardownDebuggerInterceptor(): Promise<void> {
  currentEvaluate = null;
  if (!installed) return;
  installed = false;

  chrome.debugger.onEvent.removeListener(onDebuggerEvent);
  chrome.debugger.onDetach.removeListener(onDebuggerDetach);
  chrome.tabs.onCreated.removeListener(onTabCreated);
  chrome.tabs.onUpdated.removeListener(onTabUpdated);

  await Promise.all(
    [...attachedTabs].map(async (tabId) => {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        // Already detached (e.g. tab closed) — fine.
      }
    }),
  );
  attachedTabs.clear();
}
