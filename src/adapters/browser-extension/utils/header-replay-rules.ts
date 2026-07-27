/**
 * docs/ROADMAP.md #7.1 — replays the original page's own request headers on requests the EXTENSION
 * ITSELF later makes to a host, via a session-scoped chrome.declarativeNetRequest rule. Exists
 * because plain `fetch()` from an extension page (Merge tab, background's own `inspectStreamEntry`)
 * never carries the original page's `Referer`/`Origin` — it sends `Origin: chrome-extension://<id>`
 * and no `Referer` at all — and a lot of CDN media hotlink-protects on exactly those headers, so a
 * URL that plays fine in the browser 403s the moment Synapse tries to fetch it itself.
 *
 * Session rules, not dynamic rules (utils/dnr-network-rules.ts) — condition.tabIds is "only
 * supported for session-scoped rules" (chrome.declarativeNetRequest.RuleCondition docs), and
 * tabIds is exactly the scoping this needs: a real page's own requests for the same host must NOT
 * get these headers rewritten. Separate small id space from dnr-network-rules.ts's OWNER_RANGES (a
 * completely different chrome.declarativeNetRequest.* ruleset — dynamic vs session — ids never
 * collide across the two).
 *
 * Deliberately does NOT carry `Cookie`/`Authorization` (docs/ROADMAP.md #7.1's explicit decision):
 * storing another site's session credentials in chrome.storage is a real security liability, and
 * `fetch()` can't set either header from JS anyway (both are on the forbidden-header-name list), so
 * capturing them would buy nothing even ignoring the security cost.
 */

/**
 * Headers never captured or replayed, by reason. This is a DENYLIST because the old fixed allowlist
 * (`referer`/`origin`/`user-agent`/`range`) could only ever cover the hotlink checks that had
 * already been seen in the wild — a CDN gating on anything else (`x-requested-with`, a `sec-fetch-*`
 * value, a site's own `x-*` header) failed with exactly the same symptom as a scoping bug: a bare
 * 403 and no signal about which header was missing. Capturing by default and subtracting the
 * known-harmful is the only shape that doesn't need a code change per newly-encountered site.
 *
 * `range` and the `if-*` family are the reason this can't just be "everything except credentials":
 * they are CONDITIONAL headers. Replaying a `Range` captured from one request onto the Merge page's
 * full-segment fetches yields 206 partial bodies, and an `If-None-Match`/`If-Modified-Since` yields
 * a bodyless 304 — both silently produce a truncated or empty video rather than an error. (`range`
 * was in the old allowlist; it never bit only because manifest requests rarely carry one.)
 */
const NON_REPLAYABLE_HEADER_NAMES: ReadonlySet<string> = new Set([
  // Credentials — see this file's header comment; a deliberate security boundary, not an oversight.
  'cookie',
  'authorization',
  'proxy-authorization',
  // Conditional/ranged — replaying these corrupts the response body rather than failing loudly.
  'range',
  'if-range',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
  // Connection/transport — Chrome computes these per request; replaying a stale value ranges from
  // ignored to actively breaking response decoding (`accept-encoding`) or framing.
  'host',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'transfer-encoding',
  'content-length',
  'accept-encoding',
]);

/** Bounds on what a single detected-media entry can carry into chrome.storage — a denylist admits
 * whatever a page happens to send, so the cap is what keeps MAX_DETECTED_ITEMS entries from growing
 * unbounded. Both are far above any real request's header set/value size. */
const MAX_CAPTURED_HEADERS = 24;
const MAX_HEADER_VALUE_LENGTH = 1024;

/** `name` must already be lowercased (chrome.webRequest reports header names in the casing the
 * network stack used, so callers lowercase first). */
export function isReplayableHeader(name: string): boolean {
  return !NON_REPLAYABLE_HEADER_NAMES.has(name);
}

/** Applies the two caps above to an already-denylist-filtered header map. Deterministic (insertion
 * order, i.e. the order the network stack sent them) rather than picking "important" ones — there's
 * no reliable ranking, and a request with more than MAX_CAPTURED_HEADERS headers is already outside
 * what this mechanism is for. */
export function capCapturedHeaders(headers: Record<string, string>): Record<string, string> {
  const capped: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (Object.keys(capped).length >= MAX_CAPTURED_HEADERS) break;
    if (value.length <= MAX_HEADER_VALUE_LENGTH) capped[name] = value;
  }
  return capped;
}

const MAX_HOSTS = 50; // same small-cap philosophy as MAX_DETECTED_ITEMS — this is a handful of CDN hosts per session, not an unbounded list
/** Scope key (see `scopeKeyFor`) -> the rule id this context created for it. Insertion-ordered, used
 * only for MAX_HOSTS eviction — the id itself is derived, not allocated, so it survives a restart of
 * this map. */
const scopeToRuleId = new Map<string, number>();

/** What this context last actually asked chrome.declarativeNetRequest for, per host — read only by
 * `describeHeaderReplay` below. Kept because a 403 gives no clue whether the rule was never synced,
 * was synced with the wrong headers, or was synced correctly and simply didn't match the request. */
const lastSyncedByHost = new Map<string, { ruleId: number; headerNames: string[]; tabIds: number[] }>();

/** docs/ROADMAP.md #7.1 — diagnostic snapshot for "the CDN 403'd us and the header replay was
 * supposed to prevent that". Reports what this context INTENDED (`intended`) alongside what
 * chrome.declarativeNetRequest actually holds right now (`liveRule`), because the two diverging is
 * the whole failure mode: a rule can be registered, listed, and look perfectly correct while its
 * `condition` never matches the request that needed it (the tabIds trap in syncHeaderReplayRule's
 * doc comment). Read-only and best-effort — never throws, so a caller can log it from an error path
 * without risking a second failure on top of the first. */
/** Exported by name (not just inferred from `describeHeaderReplay`'s return type) so
 * `utils/download-engine.ts` can type a background-relayed response with this same shape without
 * importing `describeHeaderReplay` itself — that function calls `chrome.declarativeNetRequest`
 * directly, which is unavailable inside the Offscreen Document the engine runs in (docs/ROADMAP.md
 * §8.11); only `background/index.ts` ever calls this function now. */
export interface DescribeHeaderReplayResult {
  intended?: { ruleId: number; headerNames: string[]; tabIds: number[] };
  liveRule?: chrome.declarativeNetRequest.Rule;
  liveRuleCount?: number;
}

export async function describeHeaderReplay(host: string): Promise<DescribeHeaderReplayResult> {
  const intended = lastSyncedByHost.get(host);
  const result: Awaited<ReturnType<typeof describeHeaderReplay>> = {};
  if (intended) result.intended = intended;
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    result.liveRuleCount = rules.length;
    const live = intended ? rules.find((r) => r.id === intended.ruleId) : undefined;
    if (live) result.liveRule = live;
  } catch {
    // Diagnostics must never mask the real error the caller is already reporting.
  }
  return result;
}

/**
 * A rule's identity is (tab scope, host) — NOT host alone.
 *
 * This mechanism is called from several extension contexts at once (the background service worker's
 * `inspectStreamEntry`, and — historically, before docs/ROADMAP.md §8.1 moved the download engine
 * off a Tab into a singleton Offscreen Document — every open ui/merge tab), each of which needs a
 * rule for the SAME host but scoped to a DIFFERENT tab. The previous per-context `nextRuleId`
 * counter starting at 1 meant they all minted id 1 for their first host and then overwrote each
 * other's rule in the single, extension-wide session ruleset — last writer wins. Observed exactly
 * that: the old Merge tab wrote `tabIds: [-1, <its tab>]`, background's auto-inspect then rewrote id
 * 1 as `tabIds: [-1]`, and every segment fetch from that tab silently stopped getting its
 * Referer/Origin. The failure is timing-dependent, which is why the same stream "worked yesterday"
 * and 403'd today. The mechanism (per-scope rule ids below) stays generically useful for any future
 * caller that isn't `TAB_ID_NONE`-scoped, even though the download engine itself no longer is one
 * (see the `tabIds` doc comment on `syncHeaderReplayRule` below).
 */
function scopeKeyFor(host: string, tabIds: number[]): string {
  return `${[...tabIds].sort((a, b) => a - b).join(',')}|${host}`;
}

/** Deterministic scope-key -> positive int32, mirroring dnr-network-rules.ts's `ruleIdsFor` (FNV-1a):
 * a derived id means two contexts can never collide unless their scope keys are equal — in which
 * case they genuinely describe the same rule and overwriting is correct. Distinct id space from
 * dnr-network-rules.ts's OWNER_RANGES for free: that one manages DYNAMIC rules, this one SESSION
 * rules, and Chrome keeps the two rulesets entirely separate. */
function ruleIdFor(host: string, tabIds: number[]): number {
  const key = scopeKeyFor(host, tabIds);
  const existing = scopeToRuleId.get(key);
  if (existing !== undefined) return existing;
  if (scopeToRuleId.size >= MAX_HOSTS) {
    // Evict the oldest (Map preserves insertion order) rather than growing unbounded — a session
    // touching more than 50 distinct hotlink-protected CDN hosts is not a case worth optimizing for.
    const oldestKey = scopeToRuleId.keys().next().value as string;
    const oldestId = scopeToRuleId.get(oldestKey)!;
    scopeToRuleId.delete(oldestKey);
    void chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [oldestId] }).catch(() => {});
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const id = 2 + ((hash >>> 1) % 1_000_000); // +2 sidesteps id 0/1 edge cases, same as dnr-network-rules.ts
  scopeToRuleId.set(key, id);
  return id;
}

/**
 * Syncs (adds/replaces) a session rule so the extension's OWN subsequent requests to `host` get
 * `headers` set — a real page's requests for the same host stay untouched. Idempotent per host —
 * safe to call before every fetch to that host; only actually talks to chrome.declarativeNetRequest
 * when the header set for that host changed. Callable from any extension context with the
 * `declarativeNetRequest` permission — not background-only, unlike webrequest-media-observer.ts.
 *
 * `tabIds` defaults to `[TAB_ID_NONE]` (-1), which matches only requests originating from no tab at
 * all — correct for the background service worker's own `fetch()` (network-sniffer's
 * `inspectStreamEntry`) and, since docs/ROADMAP.md §8.1, ALSO correct for the download engine
 * (utils/download-engine.ts): it now runs in a singleton Offscreen Document rather than a Tab, and
 * an offscreen document's own fetches carry no tabId either, so it uses this same default. This
 * default was WRONG, silently as a 403, for the download engine's PREVIOUS home: an extension page
 * actually rendered in a Tab (the old `ui/merge`) issues its `fetch()` calls with that tab's own
 * positive tabId, so the default never matched them and the hotlink-protected CDN saw
 * `Origin: chrome-extension://<id>` with no `Referer`. Any FUTURE caller that's a real Tab-rendered
 * page must still pass its own `chrome.tabs.getCurrent()` id explicitly (needs no `tabs`
 * permission) — this default only ever covers the "no tab" case.
 *
 * Callers pass the COMPLETE list they want matched rather than extra ids appended to -1: a tab's
 * rule has no business also claiming the background's requests, and keeping the scopes disjoint is
 * what lets several contexts hold rules for one host simultaneously (see `scopeKeyFor`).
 */
export async function syncHeaderReplayRule(
  host: string,
  headers: Record<string, string>,
  tabIds: number[] = [chrome.tabs.TAB_ID_NONE],
): Promise<void> {
  if (Object.keys(headers).length === 0) return;
  const id = ruleIdFor(host, tabIds);
  lastSyncedByHost.set(host, { ruleId: id, headerNames: Object.keys(headers), tabIds });
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
          condition: { requestDomains: [host], tabIds },
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
