/**
 * Generic background-only network rule sync built on chrome.declarativeNetRequest (Environment
 * SDK — see the sdk-layers skill's mechanism-vs-policy rule; docs/ROADMAP.md #2.6). Unlike
 * utils/main-world/network-interceptor.ts and utils/debugger-network-interceptor.ts (both of which
 * evaluate a per-request JS callback live), this mechanism is purely declarative: Chrome's own
 * network stack evaluates the rules natively, so there's no callback here at all — this file's only
 * job is translating the caller's desired rule set into `chrome.declarativeNetRequest.updateDynamicRules()`
 * calls whenever it changes. Requires the 'declarativeNetRequest' permission (manifest.config.ts).
 *
 * No domain knowledge here — `DnrRuleSpec` is a generic shape (url-match regex + method + one of
 * block/redirect/headers-only), not a MockConfig. Each business composition root
 * (http-error-mocker/index.ts, background/modules/iframe-unsandbox/index.ts) decides what a rule
 * means; this file only knows how to turn that decision into real DNR rules.
 *
 * Real limits of the underlying API worth knowing when reading this file: RE2 (which
 * `regexFilter` uses) has no lookahead/backreference support, so a `DnrRuleSpec` can only ever
 * carry one URL-matching regex — no way to layer an independent "and also contains X" condition on
 * top (why `requestMatchContains` isn't supported for this mechanism — see
 * shared/http-mock.ts's `validateMockConfig`). A rule's `action` is a single `type` — redirect and
 * header-modification can't be combined into one rule, so a spec needing both becomes two DNR
 * rules sharing one `condition` (see `buildRules`).
 *
 * Owner-scoped rule ids (docs/ROADMAP.md #4 Part C): this mechanism now has two consumers
 * (http-error-mocker, iframe-unsandbox), so `syncDnrRules`/`clearDnrRules` take an `ownerId` and
 * only ever touch that owner's own rule ids — no longer the "sole owner, wipe everything found"
 * assumption the original single-consumer version made.
 */

export interface DnrRedirectAction {
  kind: 'redirect';
  url: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

/** A header operation richer than DnrRedirectAction's SET-only `Record<string,string>` — needed to
 * express "remove this header outright" (e.g. stripping a response's own Content-Security-Policy),
 * which isn't expressible as "set it to some value". */
export interface DnrHeaderOp {
  operation: 'set' | 'remove';
  /** Required when `operation: 'set'`, meaningless (and ignored) for `'remove'`. */
  value?: string;
}

/** No redirect/block at all — just header modification. First consumer: iframe-unsandbox stripping
 * a response's Content-Security-Policy header (docs/ROADMAP.md #4 Part C). */
export interface DnrHeadersOnlyAction {
  kind: 'headers-only';
  requestHeaders?: Record<string, DnrHeaderOp>;
  responseHeaders?: Record<string, DnrHeaderOp>;
}

export interface DnrRuleSpec {
  /** Caller's own id (e.g. MockConfig.id) — this file derives the numeric DNR rule id(s) from it
   * (namespaced by `ownerId`), so the caller never has to track a separate id mapping itself. */
  id: string;
  /** RE2-compatible regex source (see shared/http-mock.ts's `endpointPatternToRegexSource`) matched
   * against the full request URL — not anchored, same substring-match convention every other
   * mechanism here already uses. */
  urlRegex: string;
  /** 'ALL' (or omitted) matches every HTTP method — mirrors MockConfig.method's own convention. */
  method?: string;
  /** Defaults to every resource type (this mechanism's original behavior, needed for
   * http-error-mocker's "catch everything, navigation included" parity with 'debugger') — a caller
   * that only cares about one resource type (e.g. iframe-unsandbox's `['sub_frame']`) can narrow it
   * so the rule never touches unrelated traffic. */
  resourceTypes?: chrome.declarativeNetRequest.ResourceType[];
  action: { kind: 'block' } | DnrRedirectAction | DnrHeadersOnlyAction;
}

// Default when a DnrRuleSpec doesn't set its own `resourceTypes` — DNR's own default, when neither
// `resourceTypes` nor `excludedResourceTypes` is set, excludes 'main_frame'. We want parity with
// 'debugger' (catch everything) unless a caller deliberately narrows it.
const ALL_RESOURCE_TYPES: chrome.declarativeNetRequest.ResourceType[] = Object.values(
  chrome.declarativeNetRequest.ResourceType,
);

// Disjoint numeric id ranges per owner so two consumers' rule ids can never collide, and so each
// owner can compute "which existing dynamic rule ids are mine" from getDynamicRules() alone — no
// extra storage needed. Add a new owner here (and only here) before it calls syncDnrRules/
// clearDnrRules for the first time.
const OWNER_RANGES: Record<string, number> = {
  'http-error-mocker': 0,
  'iframe-unsandbox': 1,
};
const RANGE_SIZE = 1_000_000;

function ownerOffset(ownerId: string): number {
  const index = OWNER_RANGES[ownerId];
  if (index === undefined) throw new Error(`dnr-network-rules: unknown owner "${ownerId}" — add it to OWNER_RANGES first.`);
  return index * RANGE_SIZE;
}

/** Deterministic string -> pair-of-positive-int32 (FNV-1a hash), offset into `ownerId`'s own numeric
 * range, so a caller id always maps to the same DNR rule ids across syncs for that owner —
 * `updateDynamicRules` needs stable ids to replace a rule in place rather than accumulate stale
 * duplicates. Two ids landing on the same hash (within one owner) would collide; astronomically
 * unlikely for the handful of rules a personal tool like this manages, not defended against further. */
function ruleIdsFor(ownerId: string, id: string): { primary: number; headers: number } {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const base = (hash >>> 1) % (RANGE_SIZE - 4); // keep *2+2/+3 within this owner's range
  const offset = ownerOffset(ownerId);
  return { primary: offset + base * 2 + 2, headers: offset + base * 2 + 3 }; // +2 sidesteps id 0/1 edge cases
}

function toHeaderInfos(headers: Record<string, string>): chrome.declarativeNetRequest.ModifyHeaderInfo[] {
  return Object.entries(headers).map(([header, value]) => ({
    header,
    operation: chrome.declarativeNetRequest.HeaderOperation.SET,
    value,
  }));
}

function toHeaderInfosWithOp(headers: Record<string, DnrHeaderOp>): chrome.declarativeNetRequest.ModifyHeaderInfo[] {
  return Object.entries(headers).map(([header, op]) => ({
    header,
    operation:
      op.operation === 'remove' ? chrome.declarativeNetRequest.HeaderOperation.REMOVE : chrome.declarativeNetRequest.HeaderOperation.SET,
    ...(op.operation === 'set' ? { value: op.value } : {}),
  }));
}

function buildRules(ownerId: string, spec: DnrRuleSpec): chrome.declarativeNetRequest.Rule[] {
  const { primary, headers } = ruleIdsFor(ownerId, spec.id);
  const upperMethod = spec.method?.toUpperCase();
  // Our HttpMethod values ('GET'|'POST'|...) lowercase directly onto RequestMethod's enum values
  // ('get'|'post'|...) — no separate lookup table needed, 'ALL' is simply omitted (matches every
  // method, RuleCondition's own convention for "unspecified").
  const condition: chrome.declarativeNetRequest.RuleCondition = {
    regexFilter: spec.urlRegex,
    resourceTypes: spec.resourceTypes ?? ALL_RESOURCE_TYPES,
    ...(upperMethod && upperMethod !== 'ALL'
      ? { requestMethods: [upperMethod.toLowerCase() as chrome.declarativeNetRequest.RequestMethod] }
      : {}),
  };

  if (spec.action.kind === 'block') {
    return [{ id: primary, condition, action: { type: chrome.declarativeNetRequest.RuleActionType.BLOCK } }];
  }

  if (spec.action.kind === 'headers-only') {
    const { requestHeaders, responseHeaders } = spec.action;
    return [
      {
        id: primary,
        condition,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          ...(requestHeaders ? { requestHeaders: toHeaderInfosWithOp(requestHeaders) } : {}),
          ...(responseHeaders ? { responseHeaders: toHeaderInfosWithOp(responseHeaders) } : {}),
        },
      },
    ];
  }

  const rules: chrome.declarativeNetRequest.Rule[] = [
    {
      id: primary,
      condition,
      priority: 1,
      action: { type: chrome.declarativeNetRequest.RuleActionType.REDIRECT, redirect: { url: spec.action.url } },
    },
  ];

  // redirect and modifyHeaders can't share one rule (a Rule's action.type is a single value) — a
  // spec needing both becomes two rules over the same condition; DNR evaluates them independently
  // and combines the effects (redirect/block/allow are mutually exclusive per request, but
  // modifyHeaders always applies in addition).
  const { requestHeaders, responseHeaders } = spec.action;
  if (requestHeaders || responseHeaders) {
    rules.push({
      id: headers,
      condition,
      priority: 1,
      action: {
        type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
        ...(requestHeaders ? { requestHeaders: toHeaderInfos(requestHeaders) } : {}),
        ...(responseHeaders ? { responseHeaders: toHeaderInfos(responseHeaders) } : {}),
      },
    });
  }
  return rules;
}

/** Replaces `ownerId`'s own slice of the dynamic ruleset with exactly what `specs` describes — call
 * every time that owner's active dnr-mechanism configs change (mirrors main-world/debugger's
 * re-sync-every-time policy). Only touches rule ids inside `ownerId`'s numeric range (see
 * OWNER_RANGES) — a second owner's rules are left completely untouched. */
export async function syncDnrRules(ownerId: string, specs: DnrRuleSpec[]): Promise<void> {
  const offset = ownerOffset(ownerId);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.filter((rule) => rule.id >= offset && rule.id < offset + RANGE_SIZE).map((rule) => rule.id);
  const addRules = specs.flatMap((spec) => buildRules(ownerId, spec));

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (err) {
    // A malformed rule (e.g. a data: URL Chrome rejects, an invalid regexFilter) shouldn't crash
    // the whole sync — graceful-fail, matching the Scheduler's philosophy for a single bad Module.
    console.error('Synapse: chrome.declarativeNetRequest.updateDynamicRules failed', err);
  }
}

/** Call once no active config for this owner needs this mechanism, so its rules don't linger
 * forever. Only removes rule ids inside `ownerId`'s own range. */
export async function clearDnrRules(ownerId: string): Promise<void> {
  const offset = ownerOffset(ownerId);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.filter((rule) => rule.id >= offset && rule.id < offset + RANGE_SIZE).map((rule) => rule.id);
  if (removeRuleIds.length === 0) return;
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
}
