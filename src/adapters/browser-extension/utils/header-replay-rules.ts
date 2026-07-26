/**
 * docs/ROADMAP.md #7.1 — replays a small allowlisted set of request headers (`Referer`/`Origin`/
 * `User-Agent`/`Range`) on requests the EXTENSION ITSELF later makes to a host, via a
 * session-scoped chrome.declarativeNetRequest rule. Exists because plain `fetch()` from an
 * extension page (Merge tab, background's own `inspectStreamEntry`) never carries the original
 * page's `Referer`/`Origin` — it sends `Origin: chrome-extension://<id>` and no `Referer` at all —
 * and a lot of CDN media hotlink-protects on exactly those headers, so a URL that plays fine in the
 * browser 403s the moment Synapse tries to fetch it itself.
 *
 * Session rules, not dynamic rules (utils/dnr-network-rules.ts) — condition.tabIds is "only
 * supported for session-scoped rules" (chrome.declarativeNetRequest.RuleCondition docs), and
 * `tabIds: [chrome.tabs.TAB_ID_NONE]` (a request not associated with any tab, e.g. one the
 * extension itself issued) is exactly the scoping this needs — a real page's own requests for the
 * same host must NOT get these headers rewritten. Separate small id space from
 * dnr-network-rules.ts's OWNER_RANGES (a completely different chrome.declarativeNetRequest.*
 * ruleset — dynamic vs session — ids never collide across the two).
 *
 * Deliberately does NOT carry `Cookie`/`Authorization` (docs/ROADMAP.md #7.1's explicit decision):
 * storing another site's session credentials in chrome.storage is a real security liability, and
 * `fetch()` can't set either header from JS anyway (both are on the forbidden-header-name list), so
 * capturing them would buy nothing even ignoring the security cost.
 */

/** Lowercase header names this mechanism ever captures/replays — anything else observed on the
 * original request is dropped before it's ever stored (see webrequest-media-observer.ts). */
export const REPLAYABLE_HEADER_NAMES = ['referer', 'origin', 'user-agent', 'range'] as const;

const MAX_HOSTS = 50; // same small-cap philosophy as MAX_DETECTED_ITEMS — this is a handful of CDN hosts per session, not an unbounded list
const hostToRuleId = new Map<string, number>();
let nextRuleId = 1;

function ruleIdFor(host: string): number {
  const existing = hostToRuleId.get(host);
  if (existing !== undefined) return existing;
  if (hostToRuleId.size >= MAX_HOSTS) {
    // Evict the oldest host (Map preserves insertion order) rather than growing unbounded — a
    // session touching more than 50 distinct hotlink-protected CDN hosts is not a case worth
    // optimizing for.
    const oldestHost = hostToRuleId.keys().next().value as string;
    const oldestId = hostToRuleId.get(oldestHost)!;
    hostToRuleId.delete(oldestHost);
    void chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [oldestId] }).catch(() => {});
  }
  const id = nextRuleId++;
  hostToRuleId.set(host, id);
  return id;
}

/**
 * Syncs (adds/replaces) a session rule so the extension's OWN subsequent requests to `host` get
 * `headers` set — a real page's requests for the same host stay untouched. Idempotent per host —
 * safe to call before every fetch to that host; only actually talks to chrome.declarativeNetRequest
 * when the header set for that host changed. Callable from any extension context with the
 * `declarativeNetRequest` permission (background or an extension page like ui/merge — this isn't
 * background-only, unlike webrequest-media-observer.ts).
 *
 * `TAB_ID_NONE` (-1) alone is NOT enough scoping, and getting this wrong fails silently as a 403:
 * it only matches requests that originate from no tab at all (the background service worker's own
 * `fetch()`, e.g. network-sniffer's `inspectStreamEntry`). An EXTENSION PAGE rendered in a tab —
 * ui/merge, which is where every segment download actually happens — issues its `fetch()` calls
 * with that tab's own positive tabId, so the rule never matched them and the hotlink-protected CDN
 * saw `Origin: chrome-extension://<id>` with no `Referer`. Callers running in a tab must pass their
 * own `chrome.tabs.getCurrent()` id via `extraTabIds` (no `tabs` permission needed for that call).
 */
export async function syncHeaderReplayRule(
  host: string,
  headers: Record<string, string>,
  extraTabIds: number[] = [],
): Promise<void> {
  if (Object.keys(headers).length === 0) return;
  const id = ruleIdFor(host);
  const requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = Object.entries(headers).map(
    ([header, value]) => ({ header, operation: chrome.declarativeNetRequest.HeaderOperation.SET, value }),
  );

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [
        {
          id,
          priority: 1,
          condition: { requestDomains: [host], tabIds: [chrome.tabs.TAB_ID_NONE, ...extraTabIds] },
          action: { type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS, requestHeaders },
        },
      ],
    });
  } catch (err) {
    // A malformed host/header shouldn't crash the caller's download — graceful-fail, same posture
    // as dnr-network-rules.ts's syncDnrRules.
    console.error('Synapse: header-replay-rules updateSessionRules failed', err);
  }
}
