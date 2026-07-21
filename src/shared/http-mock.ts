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
 * - 'debugger': attaches chrome.debugger (CDP Fetch domain, utils/debugger-network-interceptor.ts) to
 *   tabs — real network-stack traffic, visible in the Network tab, catches every request type
 *   (images, scripts, downloads), at the cost of the 'debugger' permission and a persistent
 *   "being debugged" banner Chrome shows on affected tabs.
 */
export type Mechanism = 'main-world' | 'debugger';
export const MECHANISMS: Mechanism[] = ['main-world', 'debugger'];
/** Configs persisted before this field existed have no `mechanism` — treat that as the original
 * (and cheapest) behavior rather than forcing a storage migration. */
export const DEFAULT_MECHANISM: Mechanism = 'main-world';

export interface MockConfig {
  id: string;
  endpointPattern: string;
  method: HttpMethod;
  mechanism: Mechanism;
  fakeStatus: number;
  fakeResponse: unknown;
  delayMs?: number;
  active: boolean;
}

/** Back-compat accessor for configs persisted before `mechanism` existed. */
export function getMechanism(config: MockConfig): Mechanism {
  return config.mechanism ?? DEFAULT_MECHANISM;
}

export type MockConfigValidation =
  | { valid: true; config: MockConfig }
  | { valid: false; reason: string };

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
  if (typeof c.fakeStatus !== 'number' || c.fakeStatus < 100 || c.fakeStatus > 599) {
    return { valid: false, reason: 'fakeStatus must be a number between 100 and 599' };
  }
  if (c.delayMs !== undefined && (typeof c.delayMs !== 'number' || c.delayMs < 0)) {
    return { valid: false, reason: 'delayMs must be a non-negative number' };
  }
  if (typeof c.active !== 'boolean') {
    return { valid: false, reason: 'active must be a boolean' };
  }

  const config: MockConfig = {
    id: c.id,
    endpointPattern: c.endpointPattern,
    method: c.method as HttpMethod,
    mechanism: c.mechanism as Mechanism,
    fakeStatus: c.fakeStatus,
    fakeResponse: c.fakeResponse,
    active: c.active,
  };
  if (c.delayMs !== undefined) config.delayMs = c.delayMs as number;
  return { valid: true, config };
}

/**
 * Compiles an endpointPattern into a RegExp: `*` is a wildcard (any run of characters, same
 * convention as Chrome match patterns / most request-blocking extensions), every other character
 * is matched literally — so a URL containing `?`/`.`/etc. doesn't need escaping by the user. Not
 * anchored, matching the old substring-`includes` behavior for a plain (no `*`) pattern.
 */
function compileEndpointPattern(pattern: string): RegExp {
  const escaped = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(escaped);
}

/** First active config for the given `mechanism` whose method + endpointPattern (glob match, see
 * compileEndpointPattern) matches the request URL. Each mechanism's composition root (see
 * main-world-payload.ts / debugger-network-interceptor.ts's caller) only ever wants configs meant
 * for itself — a 'debugger' rule must never be silently answered by the 'main-world' patch or
 * vice versa. */
export function matchMockConfig(configs: MockConfig[], url: string, method: string, mechanism: Mechanism): MockConfig | undefined {
  const upperMethod = method.toUpperCase();
  return configs.find(
    (c) =>
      c.active &&
      getMechanism(c) === mechanism &&
      (c.method === 'ALL' || c.method === upperMethod) &&
      compileEndpointPattern(c.endpointPattern).test(url),
  );
}

export interface FakeResponseInit {
  status: number;
  statusText: string;
  bodyText: string;
}

/** Renders a MockConfig's fake payload into the primitives fetch/XHR faking need — no Response/XHR
 * construction here, since those classes don't exist outside a DOM-ish environment. */
export function buildFakeResponseInit(config: MockConfig): FakeResponseInit {
  return {
    status: config.fakeStatus,
    statusText: `Mocked by Synapse (${config.id})`,
    bodyText: typeof config.fakeResponse === 'string' ? config.fakeResponse : JSON.stringify(config.fakeResponse),
  };
}

/** True when at least one config in the list would actually intercept something under `mechanism`. */
export function hasActiveMockConfig(configs: MockConfig[], mechanism: Mechanism): boolean {
  return configs.some((c) => c.active && getMechanism(c) === mechanism);
}
