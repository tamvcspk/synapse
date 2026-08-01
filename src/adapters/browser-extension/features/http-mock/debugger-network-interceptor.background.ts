import type { InterceptDecision, InterceptRequest } from '../../utils/main-world/network-interceptor';

/**
 * Generic background-only network interception mechanism built on chrome.debugger + CDP's Fetch
 * domain (Environment SDK — see the sdk-layers skill's mechanism-vs-policy rule; docs/ROADMAP.md
 * #2.6). Unlike utils/main-world/network-interceptor.ts (which patches window.fetch/XHR *inside*
 * the page, so a mocked request never touches the real network stack), this attaches Chrome's
 * remote debugging protocol to a tab and intercepts at the network-stack level — the same
 * mechanism DevTools itself uses. That's what makes mocked requests show up in the Network tab and
 * lets this mechanism catch every request type (images, scripts, downloads), not just fetch/XHR.
 *
 * No domain knowledge here — same `InterceptRequest`/`InterceptDecision` shapes the MAIN-world
 * interceptor uses (see that file), reused rather than duplicated, so a caller can point either
 * mechanism at the same kind of business logic. This mechanism can do one thing MAIN-world never
 * can, though — `block` a request at the real network layer via `Fetch.failRequest` — so its
 * decision type is `InterceptDecision` widened with that one extra case. Requires the 'debugger'
 * permission (manifest.config.ts) and shows a persistent "being debugged" banner on every attached
 * tab — callers should only attach while at least one rule actually needs this mechanism, and
 * detach the moment none do.
 */

// CDP's Fetch domain isn't in @types/chrome (chrome.debugger.sendCommand's params/result are
// typed as a bare `Object`) — this is the minimal slice of its schema this file actually reads.
// `headers` (Network.Headers — a plain name->value map) is REQUIRED here, not optional decoration:
// see `onDebuggerEvent`'s rewrite branch for why the original request's headers have to be read
// from this event at all.
interface FetchRequestPausedEvent {
  requestId: string;
  request: { url: string; method: string; postData?: string; headers: Record<string, string> };
}

/** `main-world`'s `InterceptDecision` plus `'block'` — only `chrome.debugger` (real network-stack
 * access) can produce an actual network-level failure; `main-world` can only reject a Promise in
 * JS, which isn't the same thing to a page's error handling, so it was never worth adding there. */
export type DebuggerInterceptDecision = InterceptDecision | { intercept: 'block' };
// Async — unlike main-world's EvaluateRequest, this mechanism's caller may need to resolve an
// uploaded file's bytes out of IndexedDB (docs/ROADMAP.md #2.6.1) before it can answer, which
// main-world's synchronous fetch/XHR patch could never do. Fine here: CDP holds the request paused
// until something responds, there's no "must return immediately" constraint like XHR's open()/send().
export type DebuggerEvaluateRequest = (req: InterceptRequest) => Promise<DebuggerInterceptDecision>;

let currentEvaluate: DebuggerEvaluateRequest | null = null;
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

async function onDebuggerEvent(source: chrome.debugger.Debuggee, method: string, params?: object): Promise<void> {
  if (method !== 'Fetch.requestPaused' || source.tabId === undefined) return;
  const { requestId, request } = params as unknown as FetchRequestPausedEvent;
  const tabId = source.tabId;

  const decision: DebuggerInterceptDecision = currentEvaluate
    ? await currentEvaluate({ method: request.method, url: request.url, body: request.postData })
    : { intercept: false };

  if (decision.intercept === false) {
    void chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', { requestId });
    return;
  }

  if (decision.intercept === 'block') {
    void chrome.debugger.sendCommand({ tabId }, 'Fetch.failRequest', { requestId, errorReason: 'Failed' });
    return;
  }

  if (decision.intercept === 'rewrite') {
    const { overrides } = decision;
    const commandParams: Record<string, unknown> = { requestId };
    if (overrides.url !== undefined) commandParams.url = overrides.url;
    if (overrides.method !== undefined) commandParams.method = overrides.method;
    // 'base64' means overrides.body is already-encoded file bytes (docs/ROADMAP.md §2.6.1's
    // rewriteBodyFile/rewriteBodyFileInline) — re-running it through toBase64Utf8 (meant for
    // *text*) would corrupt it, not just double-encode it. Same convention `onDebuggerEvent`'s own
    // fulfill() branch below already uses for fakeResponseFile.
    if (overrides.body !== undefined) {
      commandParams.postData = overrides.bodyEncoding === 'base64' ? overrides.body : toBase64Utf8(overrides.body);
    }
    if (overrides.headers !== undefined) {
      // CDP's `Fetch.continueRequest.headers` REPLACES the request's entire header set — it is not
      // a merge/patch, unlike `main-world`'s rewrite path (network-interceptor.ts), which layers
      // overrides on top of whatever the page already set. Sending only `overrides.headers` here
      // silently dropped every original header (Content-Type, Cookie, the lot) the moment a rule
      // rewrote even one — a real bug: the rewritten request often still reached its destination,
      // but missing headers the server needed made the override look like it "did nothing" or broke
      // the request outright. Start from the ORIGINAL headers this event already carries and let
      // `overrides.headers` win on a name collision, same "override wins" contract every other
      // mechanism's rewrite path already honors.
      const merged = { ...request.headers, ...overrides.headers };
      commandParams.headers = Object.entries(merged).map(([name, value]) => ({ name, value }));
    }
    void chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', commandParams);
    return;
  }

  const { response } = decision;
  const fulfill = () => {
    // Map, not array-concat, so a custom `Content-Type` override replaces the default instead of
    // both ending up in the header list — two same-name response headers is ambiguous, not a merge.
    const headers = new Map([['content-type', 'application/json']]);
    for (const [name, value] of Object.entries(response.headers ?? {})) headers.set(name.toLowerCase(), value);

    // 'base64' means bodyText is already-encoded file bytes (fakeResponseFile) — re-running it
    // through toBase64Utf8 (meant for *text*) would corrupt it, not just double-encode it.
    const body = response.bodyEncoding === 'base64' ? response.bodyText : toBase64Utf8(response.bodyText);

    return chrome.debugger.sendCommand({ tabId }, 'Fetch.fulfillRequest', {
      requestId,
      responseCode: response.status,
      responseHeaders: [...headers].map(([name, value]) => ({ name, value })),
      body,
    });
  };

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
export async function ensureDebuggerInterceptor(evaluate: DebuggerEvaluateRequest): Promise<void> {
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
