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
 * block/redirect), not a MockConfig. The business composition root (http-error-mocker/index.ts)
 * decides what a rule means; this file only knows how to turn that decision into real DNR rules.
 *
 * Real limits of the underlying API worth knowing when reading this file: RE2 (which
 * `regexFilter` uses) has no lookahead/backreference support, so a `DnrRuleSpec` can only ever
 * carry one URL-matching regex — no way to layer an independent "and also contains X" condition on
 * top (why `requestMatchContains` isn't supported for this mechanism — see
 * shared/http-mock.ts's `validateMockConfig`). A rule's `action` is a single `type` — redirect and
 * header-modification can't be combined into one rule, so a spec needing both becomes two DNR
 * rules sharing one `condition` (see `buildRules`).
 */

export interface DnrRedirectAction {
  kind: 'redirect';
  url: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

export interface DnrRuleSpec {
  /** Caller's own id (e.g. MockConfig.id) — this file derives the numeric DNR rule id(s) from it,
   * so the caller never has to track a separate id mapping itself. */
  id: string;
  /** RE2-compatible regex source (see shared/http-mock.ts's `endpointPatternToRegexSource`) matched
   * against the full request URL — not anchored, same substring-match convention every other
   * mechanism here already uses. */
  urlRegex: string;
  /** 'ALL' (or omitted) matches every HTTP method — mirrors MockConfig.method's own convention. */
  method?: string;
  action: { kind: 'block' } | DnrRedirectAction;
}

// All resourceTypes are listed explicitly (not omitted) — DNR's own default, when neither
// `resourceTypes` nor `excludedResourceTypes` is set, excludes 'main_frame'. We want this
// mechanism to catch everything, navigation included, for parity with 'debugger'.
const ALL_RESOURCE_TYPES: chrome.declarativeNetRequest.ResourceType[] = Object.values(
  chrome.declarativeNetRequest.ResourceType,
);

/** Deterministic string -> pair-of-positive-int32 (FNV-1a hash) so a caller id always maps to the
 * same DNR rule ids across syncs — `updateDynamicRules` needs stable ids to replace a rule in place
 * rather than accumulate stale duplicates. Two ids landing on the same hash would collide;
 * astronomically unlikely for the handful of rules a personal tool like this manages, not defended
 * against further. */
function ruleIdsFor(id: string): { primary: number; headers: number } {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const base = (hash >>> 1) % 500_000_000; // keep *2+2/+3 within a safe positive int32 range
  return { primary: base * 2 + 2, headers: base * 2 + 3 }; // +2 sidesteps id 0/1 edge cases
}

function toHeaderInfos(headers: Record<string, string>): chrome.declarativeNetRequest.ModifyHeaderInfo[] {
  return Object.entries(headers).map(([header, value]) => ({
    header,
    operation: chrome.declarativeNetRequest.HeaderOperation.SET,
    value,
  }));
}

function buildRules(spec: DnrRuleSpec): chrome.declarativeNetRequest.Rule[] {
  const { primary, headers } = ruleIdsFor(spec.id);
  const upperMethod = spec.method?.toUpperCase();
  // Our HttpMethod values ('GET'|'POST'|...) lowercase directly onto RequestMethod's enum values
  // ('get'|'post'|...) — no separate lookup table needed, 'ALL' is simply omitted (matches every
  // method, RuleCondition's own convention for "unspecified").
  const condition: chrome.declarativeNetRequest.RuleCondition = {
    regexFilter: spec.urlRegex,
    resourceTypes: ALL_RESOURCE_TYPES,
    ...(upperMethod && upperMethod !== 'ALL'
      ? { requestMethods: [upperMethod.toLowerCase() as chrome.declarativeNetRequest.RequestMethod] }
      : {}),
  };

  if (spec.action.kind === 'block') {
    return [{ id: primary, condition, action: { type: chrome.declarativeNetRequest.RuleActionType.BLOCK } }];
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

/** Replaces the *entire* set of dynamic rules with exactly what `specs` describes — call every time
 * the caller's active dnr-mechanism configs change (mirrors main-world/debugger's re-sync-every-time
 * policy). Assumes this mechanism is the sole owner of the extension's dynamic ruleset (true today —
 * http-error-mocker is the only 'dnr' consumer); a second future consumer would need this rewritten
 * to only touch its own rule ids instead of wiping everything found. */
export async function syncDnrRules(specs: DnrRuleSpec[]): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((rule) => rule.id);
  const addRules = specs.flatMap(buildRules);

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (err) {
    // A malformed rule (e.g. a data: URL Chrome rejects, an invalid regexFilter) shouldn't crash
    // the whole sync — graceful-fail, matching the Scheduler's philosophy for a single bad Module.
    console.error('Synapse: chrome.declarativeNetRequest.updateDynamicRules failed', err);
  }
}

/** Call once no active MockConfig needs this mechanism, so its rules don't linger forever. */
export async function clearDnrRules(): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  if (existing.length === 0) return;
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map((rule) => rule.id) });
}
