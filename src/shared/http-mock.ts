/**
 * Global SDK (docs/design.md §9): pure, environment-agnostic. No DOM, no chrome.*, no I/O — this
 * file must survive being bundled into the MAIN-world interceptor payload, which has zero chrome.*
 * access and doesn't share a JS heap with the extension (see main-world-interceptor skill).
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ALL';
export const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ALL'];

export interface MockConfig {
  id: string;
  endpointPattern: string;
  method: HttpMethod;
  fakeStatus: number;
  fakeResponse: unknown;
  delayMs?: number;
  active: boolean;
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

/** First active config whose method + endpointPattern (glob match, see compileEndpointPattern)
 * matches the request URL. */
export function matchMockConfig(configs: MockConfig[], url: string, method: string): MockConfig | undefined {
  const upperMethod = method.toUpperCase();
  return configs.find(
    (c) => c.active && (c.method === 'ALL' || c.method === upperMethod) && compileEndpointPattern(c.endpointPattern).test(url),
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

/** True when at least one config in the list would actually intercept something. */
export function hasActiveMockConfig(configs: MockConfig[]): boolean {
  return configs.some((c) => c.active);
}
