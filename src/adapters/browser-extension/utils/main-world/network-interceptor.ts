/**
 * Generic MAIN-world fetch/XHR interception mechanism (Environment SDK — see the sdk-layers
 * skill's mechanism-vs-policy rule). This file owns only the monkey-patching mechanics; it has no
 * concept of a "mock rule" or any other domain schema — every routing/matching decision is
 * delegated to the `evaluate` callback supplied by the caller (the business Module's MAIN-world
 * composition root). Would work unmodified if the domain type it's wired to were swapped for
 * something unrelated (e.g. a request logger instead of an error mocker) — that's the litmus test
 * for infra vs business.
 */

export interface InterceptRequest {
  method: string;
  url: string;
  body?: unknown;
}

export interface InterceptResponse {
  status: number;
  bodyText: string;
  statusText?: string;
  delayMs?: number;
}

export type InterceptDecision = { intercept: false } | { intercept: true; response: InterceptResponse };

export type EvaluateRequest = (req: InterceptRequest) => InterceptDecision;

/** Patches window.fetch and XMLHttpRequest.prototype in-place. Idempotent-by-convention: call once. */
export function installNetworkInterceptor(evaluate: EvaluateRequest): void {
  patchFetch(evaluate);
  patchXhr(evaluate);
}

function patchFetch(evaluate: EvaluateRequest): void {
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const decision = evaluate({ method, url, body: init?.body });
    if (!decision.intercept) return originalFetch(input, init);

    const { response } = decision;
    if (response.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs));

    return new Response(response.bodyText, {
      status: response.status,
      ...(response.statusText !== undefined ? { statusText: response.statusText } : {}),
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function patchXhr(evaluate: EvaluateRequest): void {
  const OriginalXhr = window.XMLHttpRequest;
  const originalOpen = OriginalXhr.prototype.open;
  const originalSend = OriginalXhr.prototype.send;

  const state = new WeakMap<XMLHttpRequest, { method: string; url: string }>();

  OriginalXhr.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    state.set(this, { method, url: url.toString() });
    // `async` defaults to true per the XHR spec when omitted — normalize so every call goes
    // through the same overload (TypeScript's `.call()` typing only exposes one overload of
    // `open()` when the method is read off the prototype as a value).
    originalOpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
  };

  OriginalXhr.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = state.get(this);
    const decision = meta ? evaluate({ method: meta.method, url: meta.url, body }) : { intercept: false as const };
    if (!decision.intercept) {
      originalSend.call(this, body);
      return;
    }

    const { response } = decision;
    const deliver = () => {
      Object.defineProperty(this, 'readyState', { value: 4, configurable: true });
      Object.defineProperty(this, 'status', { value: response.status, configurable: true });
      Object.defineProperty(this, 'statusText', { value: response.statusText ?? '', configurable: true });
      Object.defineProperty(this, 'responseText', { value: response.bodyText, configurable: true });
      Object.defineProperty(this, 'response', { value: response.bodyText, configurable: true });
      this.dispatchEvent(new Event('readystatechange'));
      this.dispatchEvent(new Event('load'));
      this.dispatchEvent(new Event('loadend'));
    };

    if (response.delayMs) setTimeout(deliver, response.delayMs);
    else deliver();
  };
}
