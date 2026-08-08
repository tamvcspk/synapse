/**
 * Global SDK (docs/design.md §9): pure, environment-agnostic. No DOM, no chrome.*, no I/O — this
 * file must survive being bundled into the MAIN-world interceptor payload, which has zero chrome.*
 * access and doesn't share a JS heap with the extension (see main-world-interceptor skill).
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ALL';
export const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ALL'];

/**
 * Which interception mechanism a rule runs under (docs/ROADMAP.md #2.6):
 * - 'main-world': patches window.fetch/XHR in the page's MAIN world (utils/main-world/network-interceptor.ts).
 *   Cheapest, no extra permission — but invisible in DevTools' Network tab and only catches fetch/XHR calls.
 * - 'debugger': attaches chrome.debugger (CDP Fetch domain, utils/debugger-network-interceptor.background.ts) to
 *   tabs — real network-stack traffic, visible in the Network tab, catches every request type
 *   (images, scripts, downloads), at the cost of the 'debugger' permission and a persistent
 *   "being debugged" banner Chrome shows on affected tabs.
 * - 'dnr': chrome.declarativeNetRequest (utils/dnr-network-rules.ts) — native MV3, no banner, real
 *   network-stack traffic (visible in Network tab, catches every resource type like `debugger`).
 *   Purely declarative: Chrome's own engine evaluates the rules, there's no live per-request JS
 *   callback at all. Real limitations from that, enforced in `validateMockConfig`: can't inspect or
 *   rewrite a request's body (DNR conditions/actions never see it, only URL/headers/resourceType),
 *   and can't change the request method. `action: 'fake-response'` only works by redirecting to a
 *   `data:` URL built from the configured body — so it always behaves as HTTP 200 regardless of
 *   `fakeStatus` (a `data:` URL has no status-code concept), a documented reduced-fidelity trade-off
 *   rather than a bug.
 */
export type Mechanism = 'main-world' | 'debugger' | 'dnr';
export const MECHANISMS: Mechanism[] = ['main-world', 'debugger', 'dnr'];
/** Configs persisted before this field existed have no `mechanism` — treat that as the original
 * (and cheapest) behavior rather than forcing a storage migration. */
export const DEFAULT_MECHANISM: Mechanism = 'main-world';

/**
 * What a rule does once it matches (docs/ROADMAP.md #2.6.1) — independent of `mechanism` (which
 * decides *how* the match is intercepted):
 * - 'fake-response': never touches the network, answers with `fakeStatus`/`fakeResponse` directly
 *   (the original, and still only, behavior for `mechanism: 'main-world'` pre-#2.6.1).
 * - 'rewrite-request': the request is still sent for real, but with `rewriteUrl`/`rewriteMethod`/
 *   `rewriteHeaders`/`rewriteBody` overrides applied first. Valid for both `main-world` and
 *   `debugger` — but only `debugger` can rewrite non-fetch/XHR requests (script/image/etc. tags);
 *   `main-world`'s patch is limited to what `window.fetch`/`XMLHttpRequest` themselves originate.
 * - 'block': fails the request outright at the real network layer (`Fetch.failRequest`, or DNR's
 *   native `block` action) — requires `mechanism: 'debugger'` or `'dnr'`, since `main-world` can
 *   only reject a Promise in JS, never produce an actual network-level failure a page's error
 *   handling would see the same way.
 */
export type Action = 'fake-response' | 'rewrite-request' | 'block';
export const ACTIONS: Action[] = ['fake-response', 'rewrite-request', 'block'];
/** Configs persisted before this field existed have no `action` — they were always fake-response
 * rules (the only action that existed then). */
export const DEFAULT_ACTION: Action = 'fake-response';

/** Server-side backstop for item-form-view.ts's ~2MB client-side cap on `fakeResponseFileInline`
 * (base64 inflates a binary size by ~4/3) — defends against a malformed/tampered upsert bypassing
 * the client check, not a normal code path. */
const MAX_INLINE_FILE_BASE64_LENGTH = 3 * 1024 * 1024;

export interface MockConfig {
  id: string;
  endpointPattern: string;
  method: HttpMethod;
  mechanism: Mechanism;
  action: Action;
  /** Only meaningful when `action === 'fake-response'`. */
  fakeStatus?: number;
  fakeResponse?: unknown;
  /** A blobRef into utils/blob-store.ts's IndexedDB (docs/ROADMAP.md #2.6.1's fake-file support) —
   * when set, **takes precedence over `fakeResponse`** (the uploaded file's bytes answer the
   * request instead of the typed text). **`mechanism: 'debugger'` only** — resolving a blobRef
   * needs IndexedDB access, which the MAIN-world patch's evaluate() callback never has (same
   * reason as `hitCountLimit`). `main-world` uses `fakeResponseFileInline` instead (see below); this
   * field stays `undefined` for a `main-world` rule's file upload. This file itself stays I/O-free
   * (Global SDK, docs/design.md §9) — resolving the blobRef into actual bytes happens in the
   * background composition root (http-error-mocker.background.ts's `evaluateDebuggerRequest`), never
   * here. Item-form-view.ts's file field submits BOTH this and `fakeResponseFileInline` at once, as
   * one JSON string — see `parseFileFieldValue`. */
  fakeResponseFile?: string;
  /** The same uploaded file as `fakeResponseFile`, but inlined directly (not a reference) — this is
   * what `mechanism: 'main-world'` actually uses, since it can't reach IndexedDB but *can* reach
   * whatever's on this MockConfig itself (it already rides the exact same chrome.storage.local sync
   * every other field here uses, via installStorageToMainWorldRelay — no new relay mechanism
   * needed). Deliberately capped client-side (item-form-view.ts, ~2MB) and re-checked here
   * (`MAX_INLINE_FILE_BASE64_LENGTH`) — chrome.storage.local's ~5MB quota is shared by the *entire*
   * extension, not just this one field, so an uncapped inline file would risk starving everything
   * else. A file over the cap simply has no `fakeResponseFileInline` — main-world just won't fake
   * it (mechanism: debugger, unaffected by this cap, still works via `fakeResponseFile`). */
  fakeResponseFileInline?: { mimeType: string; fileName: string; base64: string };
  /** The uploaded file's original name — kept as its own top-level field (rather than only inside
   * `fakeResponseFileInline`) so a display like the Management View table has something readable
   * to show *regardless* of mechanism/inline-cap status, without needing an IndexedDB lookup per
   * row. Cosmetic only — never read by any evaluate() path, only by item-form-view.ts (for editing)
   * and management-view.ts (for display). */
  fakeResponseFileName?: string;
  delayMs?: number;
  /** Rewrite fields below are only meaningful when `action === 'rewrite-request'`; each is
   * optional independently — an omitted one means "keep the original request's value". */
  rewriteUrl?: string;
  rewriteMethod?: string;
  /** Multiline JSON text (e.g. `{"X-Foo":"bar"}`), parsed by `buildRewriteOverrides` — same
   * free-text-that-happens-to-be-JSON convention `fakeResponse` already uses, rather than
   * inventing a dedicated "key-value list" UIFieldDef type for just this one field. */
  rewriteHeaders?: string;
  rewriteBody?: string;
  /** docs/ROADMAP.md §2.6.1 — same blobRef/inline/name trio as `fakeResponseFile` below, for
   * `action: 'rewrite-request'`'s body instead of a fake response's. Only meaningful together with
   * `mechanism: 'main-world'|'debugger'` (same as `rewriteBody`/`rewriteMethod` — 'dnr' has no
   * action to rewrite a request body at all). Takes precedence over `rewriteBody` text when set,
   * same "file beats typed text" precedence `fakeResponseFile` already establishes. */
  rewriteBodyFile?: string;
  /** `mechanism: 'main-world'` counterpart to `rewriteBodyFile`, same reasoning as
   * `fakeResponseFileInline` — the MAIN-world patch can't reach IndexedDB, only whatever's inlined
   * onto this MockConfig itself. Same ~2MB client-side cap (item-form-view.ts), re-checked here via
   * the shared `parseFileFieldValue`. */
  rewriteBodyFileInline?: { mimeType: string; fileName: string; base64: string };
  /** Cosmetic display name, same role as `fakeResponseFileName`. */
  rewriteBodyFileName?: string;
  /** Multiline JSON text merged into the fake response's headers (default is always just
   * `Content-Type: application/json`) — only meaningful when `action === 'fake-response'`. */
  responseHeaders?: string;
  /** Extra matching condition on top of endpointPattern+method: substring match against the URL
   * (and, where the mechanism's evaluate-time has it, the request body) — independent of `action`,
   * since it's about *whether* a rule matches at all, not what it does once matched. See
   * `matchMockConfig`'s doc comment for the `mechanism: 'main-world'` + XHR caveat. */
  requestMatchContains?: string;
  /** Auto-disables the rule (`active: false`) after this many matches — **`mechanism: 'debugger'`
   * only**: persisting the incremented count needs chrome.* storage access, which the MAIN-world
   * patch's evaluate() callback never has (see main-world-interceptor skill); `main-world` rules
   * read this field but never act on it. */
  hitCountLimit?: number;
  /** Runtime bookkeeping for `hitCountLimit` — never a form field, just carried through
   * `{...existing}` on every save like any other field the form doesn't touch. */
  matchCount?: number;
  active: boolean;
  /** Set only for a rule created through `synapseApi.mock.add` (docs/api-inventory.md §3.2) —
   * absent means the rule was authored by hand in the Management View. The one thing this field
   * gates: `net-mock-host.ts`'s `.remove()`/`.list()` filter the shared collection down to a
   * script's own rules by this field, so one script can never see or delete another's (or the
   * user's own manually-created rules). Copied through as an opaque string by `validateMockConfig`
   * (never form-editable, same treatment `matchCount` gets) — the Management View form's
   * `{...existing}` spread already preserves it across an edit, but the validator has to know to
   * carry it forward or that edit would silently un-scope the rule. */
  ownerModuleId?: string;
}

/** Back-compat accessor for configs persisted before `mechanism` existed. */
export function getMechanism(config: MockConfig): Mechanism {
  return config.mechanism ?? DEFAULT_MECHANISM;
}

/** Back-compat accessor for configs persisted before `action` existed. */
export function getAction(config: MockConfig): Action {
  return config.action ?? DEFAULT_ACTION;
}

export type MockConfigValidation =
  | { valid: true; config: MockConfig }
  | { valid: false; reason: string };

/** Unpacks item-form-view.ts's combined `{blobRef?, fileName?, inline?}` JSON for a `type: 'file'`
 * field (docs/ROADMAP.md #2.6.1) into the real MockConfig fields it maps to. Best-effort: malformed
 * JSON, a missing/invalid `inline` shape, or an oversized `inline.base64` (see
 * `MAX_INLINE_FILE_BASE64_LENGTH`) all degrade to "that half is just absent" rather than rejecting
 * the whole upsert — a bad/huge file shouldn't block saving the blobRef half that's still fine. */
function parseFileFieldValue(raw: string): {
  blobRef?: string;
  fileName?: string;
  inline?: { mimeType: string; fileName: string; base64: string };
} {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const p = parsed as Record<string, unknown>;

    const blobRef = typeof p.blobRef === 'string' && p.blobRef.length > 0 ? p.blobRef : undefined;
    const fileName = typeof p.fileName === 'string' && p.fileName.length > 0 ? p.fileName : undefined;

    const rawInline = typeof p.inline === 'object' && p.inline !== null ? (p.inline as Record<string, unknown>) : undefined;
    const inlineValid =
      rawInline &&
      typeof rawInline.mimeType === 'string' &&
      typeof rawInline.fileName === 'string' &&
      typeof rawInline.base64 === 'string' &&
      rawInline.base64.length <= MAX_INLINE_FILE_BASE64_LENGTH
        ? { mimeType: rawInline.mimeType, fileName: rawInline.fileName, base64: rawInline.base64 }
        : undefined;

    return {
      ...(blobRef ? { blobRef } : {}),
      ...(fileName ? { fileName } : {}),
      ...(inlineValid ? { inline: inlineValid } : {}),
    };
  } catch {
    return {};
  }
}

/** Hand-rolled shape check (no schema lib, matching kernel/manifest-validator.ts's precedent) — used
 * to validate popup form input and any config read back from chrome.storage. */
export function validateMockConfig(candidate: unknown): MockConfigValidation {
  if (typeof candidate !== 'object' || candidate === null) {
    return { valid: false, reason: 'config is not an object' };
  }
  const c = candidate as Record<string, unknown>;

  if (typeof c.id !== 'string' || c.id.length === 0) {
    return { valid: false, reason: 'id must be a non-empty string' };
  }
  if (typeof c.endpointPattern !== 'string' || c.endpointPattern.length === 0) {
    return { valid: false, reason: 'endpointPattern must be a non-empty string' };
  }
  if (typeof c.method !== 'string' || !HTTP_METHODS.includes(c.method as HttpMethod)) {
    return { valid: false, reason: `method must be one of ${HTTP_METHODS.join(', ')}` };
  }
  if (typeof c.mechanism !== 'string' || !MECHANISMS.includes(c.mechanism as Mechanism)) {
    return { valid: false, reason: `mechanism must be one of ${MECHANISMS.join(', ')}` };
  }
  if (typeof c.action !== 'string' || !ACTIONS.includes(c.action as Action)) {
    return { valid: false, reason: `action must be one of ${ACTIONS.join(', ')}` };
  }
  const action = c.action as Action;
  const mechanism = c.mechanism as Mechanism;
  if (action === 'block' && mechanism !== 'debugger' && mechanism !== 'dnr') {
    return { valid: false, reason: `action "block" requires mechanism "debugger" or "dnr"` };
  }
  // 'dnr' can only fake-response via a data: URL redirect (see MockConfig.fakeResponseFileInline's
  // doc comment), which has no HTTP status-code concept — always resolves as a successful load
  // regardless, so fakeStatus is optional (not required) for it rather than a value the user sets
  // but that quietly never takes effect. If given anyway, it still has to be in-range.
  if (action === 'fake-response' && mechanism !== 'dnr' && (typeof c.fakeStatus !== 'number' || c.fakeStatus < 100 || c.fakeStatus > 599)) {
    return { valid: false, reason: 'fakeStatus must be a number between 100 and 599 when action is fake-response' };
  }
  if (
    action === 'fake-response' &&
    mechanism === 'dnr' &&
    c.fakeStatus !== undefined &&
    (typeof c.fakeStatus !== 'number' || c.fakeStatus < 100 || c.fakeStatus > 599)
  ) {
    return { valid: false, reason: 'fakeStatus must be a number between 100 and 599' };
  }
  if (action === 'rewrite-request' && c.rewriteMethod !== undefined && c.rewriteMethod !== '') {
    const rewriteMethods: HttpMethod[] = HTTP_METHODS.filter((m) => m !== 'ALL');
    if (typeof c.rewriteMethod !== 'string' || !rewriteMethods.includes(c.rewriteMethod.toUpperCase() as HttpMethod)) {
      return { valid: false, reason: `rewriteMethod must be one of ${rewriteMethods.join(', ')}` };
    }
  }
  // 'dnr' is purely declarative — Chrome's own engine evaluates its rules, which never see a
  // request's body and have no way to change its method (hard API limits, not gaps to fill in
  // later) — reject rather than silently ignore, since silently going through unmodified could
  // mislead whatever test this rule was set up for.
  if (mechanism === 'dnr' && action === 'rewrite-request' && c.rewriteMethod) {
    return { valid: false, reason: 'mechanism "dnr" cannot change the request method (declarativeNetRequest has no such action)' };
  }
  if (mechanism === 'dnr' && action === 'rewrite-request' && (c.rewriteBody || c.rewriteBodyFile)) {
    return { valid: false, reason: 'mechanism "dnr" cannot rewrite the request body (declarativeNetRequest has no such action)' };
  }
  if (mechanism === 'dnr' && c.requestMatchContains) {
    return {
      valid: false,
      reason: 'mechanism "dnr" cannot match on request content — declarativeNetRequest only ever sees the URL, never the body',
    };
  }
  if (c.delayMs !== undefined && (typeof c.delayMs !== 'number' || c.delayMs < 0)) {
    return { valid: false, reason: 'delayMs must be a non-negative number' };
  }
  if (c.responseHeaders !== undefined && typeof c.responseHeaders !== 'string') {
    return { valid: false, reason: 'responseHeaders must be a string' };
  }
  if (c.requestMatchContains !== undefined && typeof c.requestMatchContains !== 'string') {
    return { valid: false, reason: 'requestMatchContains must be a string' };
  }
  if (c.hitCountLimit !== undefined && (typeof c.hitCountLimit !== 'number' || c.hitCountLimit < 1)) {
    return { valid: false, reason: 'hitCountLimit must be a positive number' };
  }
  // item-form-view.ts's file field submits a single JSON string combining both storage forms
  // (`{blobRef?, inline?}`) — see MockConfig.fakeResponseFile/fakeResponseFileInline's doc comments
  // and `parseFileFieldValue` below.
  if (c.fakeResponseFile !== undefined && (typeof c.fakeResponseFile !== 'string' || c.fakeResponseFile.length === 0)) {
    return { valid: false, reason: 'fakeResponseFile must be a non-empty string' };
  }
  if (c.rewriteBodyFile !== undefined && (typeof c.rewriteBodyFile !== 'string' || c.rewriteBodyFile.length === 0)) {
    return { valid: false, reason: 'rewriteBodyFile must be a non-empty string' };
  }
  if (typeof c.active !== 'boolean') {
    return { valid: false, reason: 'active must be a boolean' };
  }

  const config: MockConfig = {
    id: c.id,
    endpointPattern: c.endpointPattern,
    method: c.method as HttpMethod,
    mechanism,
    action,
    active: c.active,
  };
  if (action === 'fake-response') {
    // Required (and validated in-range) for every mechanism except 'dnr', where it's optional —
    // see the validation block above.
    if (typeof c.fakeStatus === 'number') config.fakeStatus = c.fakeStatus;
    config.fakeResponse = c.fakeResponse;
    if (c.responseHeaders) config.responseHeaders = c.responseHeaders as string;
    if (c.fakeResponseFile) {
      const { blobRef, fileName, inline } = parseFileFieldValue(c.fakeResponseFile as string);
      if (blobRef) config.fakeResponseFile = blobRef;
      if (fileName) config.fakeResponseFileName = fileName;
      if (inline) config.fakeResponseFileInline = inline;
    }
  }
  if (action === 'rewrite-request') {
    if (c.rewriteUrl) config.rewriteUrl = c.rewriteUrl as string;
    if (c.rewriteMethod) config.rewriteMethod = (c.rewriteMethod as string).toUpperCase();
    if (c.rewriteHeaders) config.rewriteHeaders = c.rewriteHeaders as string;
    if (c.rewriteBody) config.rewriteBody = c.rewriteBody as string;
    if (c.rewriteBodyFile) {
      const { blobRef, fileName, inline } = parseFileFieldValue(c.rewriteBodyFile as string);
      if (blobRef) config.rewriteBodyFile = blobRef;
      if (fileName) config.rewriteBodyFileName = fileName;
      if (inline) config.rewriteBodyFileInline = inline;
    }
  }
  if (c.delayMs !== undefined) config.delayMs = c.delayMs as number;
  if (c.requestMatchContains) config.requestMatchContains = c.requestMatchContains as string;
  if (c.hitCountLimit !== undefined) config.hitCountLimit = c.hitCountLimit as number;
  // Never form-editable — carried over from whatever the previous save already had (0/undefined
  // for a brand-new rule), so a hit-count keeps counting across unrelated edits to the same rule.
  if (typeof c.matchCount === 'number') config.matchCount = c.matchCount;
  // Same "carried over, never form-editable" treatment as matchCount — see the field's own doc
  // comment on MockConfig for why dropping it silently would be a scoping bug, not a cosmetic one.
  if (typeof c.ownerModuleId === 'string' && c.ownerModuleId.length > 0) config.ownerModuleId = c.ownerModuleId;
  return { valid: true, config };
}

/**
 * Escapes an endpointPattern into a regex *source string*: `*` is a wildcard (any run of
 * characters, same convention as Chrome match patterns / most request-blocking extensions), every
 * other character is matched literally — so a URL containing `?`/`.`/etc. doesn't need escaping by
 * the user. Not anchored, matching the old substring-`includes` behavior for a plain (no `*`)
 * pattern. Exported as a plain string, not a compiled `RegExp`, so a caller needing something else
 * to do the compiling (`utils/dnr-network-rules.ts`'s `regexFilter`, which Chrome evaluates as RE2 —
 * compatible with the simple escaped-literal + `.*` pattern this produces) can use it directly.
 */
export function endpointPatternToRegexSource(pattern: string): string {
  return pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
}

function compileEndpointPattern(pattern: string): RegExp {
  return new RegExp(endpointPatternToRegexSource(pattern));
}

/** First active config for the given `mechanism` whose method + endpointPattern (glob match, see
 * compileEndpointPattern) matches the request URL. Each mechanism's composition root (see
 * main-world-payload.ts / debugger-network-interceptor.background.ts's caller) only ever wants configs meant
 * for itself — a 'debugger' rule must never be silently answered by the 'main-world' patch or
 * vice versa.
 *
 * `body` is optional and, when given, only ever checked against `requestMatchContains` — never
 * against endpointPattern/method. `mechanism: 'main-world'`'s XHR path evaluates at `open()` time
 * (see network-interceptor.ts), before a request body exists, so `body` is always undefined there;
 * `requestMatchContains` still works for that path, just only against the URL. */
export function matchMockConfig(
  configs: MockConfig[],
  url: string,
  method: string,
  mechanism: Mechanism,
  body?: unknown,
): MockConfig | undefined {
  const upperMethod = method.toUpperCase();
  return configs.find((c) => {
    if (!c.active || getMechanism(c) !== mechanism) return false;
    if (c.method !== 'ALL' && c.method !== upperMethod) return false;
    if (!compileEndpointPattern(c.endpointPattern).test(url)) return false;
    if (c.requestMatchContains) {
      const haystack = `${url} ${typeof body === 'string' ? body : ''}`;
      if (!haystack.includes(c.requestMatchContains)) return false;
    }
    return true;
  });
}

export interface FakeResponseInit {
  status: number;
  statusText: string;
  bodyText: string;
  headers?: Record<string, string>;
}

/** Parses a multiline-JSON-object field (best-effort — malformed JSON is treated as "no override"
 * rather than failing the whole rule, since a typo in this one optional field shouldn't take down
 * whatever else was configured correctly). Shared by `responseHeaders` and `rewriteHeaders` — same
 * free-text-that-happens-to-be-JSON convention `fakeResponse` already uses, rather than inventing
 * a dedicated "key-value list" UIFieldDef type for just these fields. */
export function parseHeadersJson(text: string | undefined): Record<string, string> | undefined {
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : undefined;
  } catch {
    return undefined;
  }
}

/** Renders a MockConfig's fake payload into the primitives fetch/XHR faking need — no Response/XHR
 * construction here, since those classes don't exist outside a DOM-ish environment. Only ever
 * called by a caller that already checked `getAction(config) === 'fake-response'`; the `?? `
 * fallbacks below are defensive (fakeStatus/fakeResponse are optional on MockConfig precisely
 * because they're meaningless for the other actions), not an expected runtime path. */
export function buildFakeResponseInit(config: MockConfig): FakeResponseInit {
  const headers = parseHeadersJson(config.responseHeaders);
  return {
    status: config.fakeStatus ?? 200,
    statusText: `Mocked by Synapse (${config.id})`,
    bodyText: typeof config.fakeResponse === 'string' ? config.fakeResponse : JSON.stringify(config.fakeResponse ?? ''),
    ...(headers ? { headers } : {}),
  };
}

export interface RewriteOverrides {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** `'utf8'` (default when omitted) means `body` is decoded text, as it always was before this
   * field existed. `'base64'` means `body` is already base64 — an uploaded file's raw bytes
   * (`rewriteBodyFileInline`, resolvable here with no I/O; `rewriteBodyFile`'s blobRef needs
   * IndexedDB, resolved by the caller instead — see `evaluateDebuggerRequest`) — and must reach
   * the network layer as-is, not re-encoded as if it were text (same `bodyEncoding` convention
   * `InterceptResponse` already uses for `fakeResponseFile`). */
  bodyEncoding?: 'utf8' | 'base64';
}

/** Renders a MockConfig's rewrite fields into the primitives a request-rewrite needs — same
 * "primitives, not environment classes" split as `buildFakeResponseInit`. Only ever called by a
 * caller that already checked `getAction(config) === 'rewrite-request'`.
 *
 * `rewriteBodyFileInline` takes precedence over `rewriteBody` text (docs/ROADMAP.md §2.6.1, same
 * "file beats typed text" precedence `fakeResponseFile`/`fakeResponse` already establishes) — it's
 * the only file-upload form resolvable here (no I/O, Global SDK): `rewriteBodyFile`'s blobRef needs
 * an actual IndexedDB read, which only the background composition root can do (mirrors
 * `fakeResponseFile`'s exact split — see that field's doc comment). A caller with `mechanism:
 * 'debugger'` (which DOES have IndexedDB access) must check `config.rewriteBodyFile` itself and
 * override the result of this function accordingly. */
export function buildRewriteOverrides(config: MockConfig): RewriteOverrides {
  const headers = parseHeadersJson(config.rewriteHeaders);
  return {
    ...(config.rewriteUrl ? { url: config.rewriteUrl } : {}),
    ...(config.rewriteMethod ? { method: config.rewriteMethod } : {}),
    ...(headers ? { headers } : {}),
    ...(config.rewriteBodyFileInline
      ? { body: config.rewriteBodyFileInline.base64, bodyEncoding: 'base64' as const }
      : config.rewriteBody
        ? { body: config.rewriteBody }
        : {}),
  };
}

/**
 * Chooses the cheapest mechanism that can honour a script-declared `net.mock` intent
 * (docs/ROADMAP.md Track B2a/B2b) — the script only declares `action` (+ these two hints), it never
 * names a mechanism itself (`net-mock-host.ts`'s `performMockAdd` calls this instead of accepting one).
 * `rpc-handler.ts` calls this SAME function, on the SAME args, before dispatch — so it can require
 * the extra `net.mock.debugger` grant exactly when (and only when) this resolves to `'debugger'`,
 * without duplicating the decision logic at the one place allowed to enforce it (§3.4).
 *
 * - `'block'`: always `'dnr'` — it already catches every resource type (utils/dnr-network-rules.ts's
 *   `ALL_RESOURCE_TYPES` default exists FOR this parity with `'debugger'`), at no banner cost.
 * - `'rewrite-request'`: `'main-world'` is enough whenever a body is being rewritten (only mechanism
 *   besides `'debugger'` that can touch a request body at all) OR neither hint applies. `'dnr'` covers
 *   a rewrite that must reach every resource type but touches no body (redirect + header-modify, no
 *   body access needed). `'debugger'` is reached ONLY for the one combination neither of those two can
 *   cover: rewriting a body on a request `main-world`'s fetch/XHR patch would never see in the first
 *   place (an `<img>`/`<script>` tag, for example) — the sole reason `net.mock.debugger` exists.
 * - `'fake-response'`: unchanged from v1, always `'main-world'`.
 */
export function chooseMechanismForScriptRule(
  action: Action,
  hints: { rewriteBody?: unknown; matchAnyResourceType?: boolean },
): Mechanism {
  if (action === 'block') return 'dnr';
  if (action === 'rewrite-request') {
    const hasBody = typeof hints.rewriteBody === 'string' && hints.rewriteBody.length > 0;
    if (hasBody) return hints.matchAnyResourceType ? 'debugger' : 'main-world';
    return hints.matchAnyResourceType ? 'dnr' : 'main-world';
  }
  return 'main-world';
}

/** True when at least one config in the list would actually intercept something under `mechanism`. */
export function hasActiveMockConfig(configs: MockConfig[], mechanism: Mechanism): boolean {
  return configs.some((c) => c.active && getMechanism(c) === mechanism);
}
