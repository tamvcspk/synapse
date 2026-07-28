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
  /** Merged on top of the default `Content-Type: application/json` — override that key too if the
   * faked response isn't JSON. */
  headers?: Record<string, string>;
  /** `'utf8'` (default when omitted) means `bodyText` is decoded text, as it always was before
   * docs/ROADMAP.md #2.6.1's fake-file support. `'base64'` means `bodyText` is already base64 —
   * an uploaded file's raw bytes, resolved by a mechanism with blob-store access (currently only
   * `debugger`, see MockConfig.fakeResponseFile's doc comment) — and must be handed to whatever
   * consumes it as-is, not re-encoded as if it were text. */
  bodyEncoding?: 'utf8' | 'base64';
}

/** Overrides applied to a request that's still sent for real (docs/ROADMAP.md #2.6.1's
 * 'rewrite-request' action) — as opposed to `InterceptResponse`, which answers without ever
 * touching the network. Every field is independently optional: an omitted one keeps the
 * original request's value. */
export interface InterceptRewriteOverrides {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** `'utf8'` (default when omitted) means `body` is decoded text. `'base64'` means `body` is an
   * uploaded file's raw bytes (docs/ROADMAP.md §2.6.1's `rewriteBodyFile`/`rewriteBodyFileInline`)
   * and must be decoded back to bytes before being sent, not passed through as the base64 *string*
   * itself — same convention `InterceptResponse.bodyEncoding` already uses for `fakeResponseFile`. */
  bodyEncoding?: 'utf8' | 'base64';
}

export type InterceptDecision =
  | { intercept: false }
  | { intercept: true; response: InterceptResponse }
  | { intercept: 'rewrite'; overrides: InterceptRewriteOverrides };

export type EvaluateRequest = (req: InterceptRequest) => InterceptDecision;

/** Resolves a possibly-relative URL (e.g. a page calling `fetch('/api/x')`) against the current
 * page so `evaluate`/pattern matching always sees an absolute URL — a no-op for already-absolute
 * input. */
function toAbsoluteUrl(url: string): string {
  return new URL(url, window.location.href).href;
}

/** Inverse of utils/blob-store.ts's `bytesToBase64` — kept as a separate copy rather than an
 * import, since that file's `indexedDB` calls would resolve to the *page's* IndexedDB if it were
 * ever pulled into this MAIN-world bundle (see main-world-interceptor skill), not the extension's;
 * this one function is plain byte<->string conversion with no such dependency, so duplicating it
 * is safer than importing a file with an unrelated environment assumption. */
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Patches window.fetch and XMLHttpRequest.prototype in-place. Idempotent-by-convention: call once. */
export function installNetworkInterceptor(evaluate: EvaluateRequest): void {
  patchFetch(evaluate);
  patchXhr(evaluate);
}

/** `overrides.bodyEncoding === 'base64'` means `overrides.body` is an uploaded file's raw bytes
 * (docs/ROADMAP.md §2.6.1) — decoded back to bytes so binary content reaches the network intact
 * instead of being sent as the base64 *string* itself (same reasoning as `patchFetch`'s existing
 * fake-response `bodyEncoding` handling below, just on the request side instead of the response). */
function resolveRewriteBody(overrides: InterceptRewriteOverrides): BodyInit | undefined {
  if (overrides.body === undefined) return undefined;
  return overrides.bodyEncoding === 'base64' ? base64ToBytes(overrides.body) : overrides.body;
}

function patchFetch(evaluate: EvaluateRequest): void {
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = toAbsoluteUrl(rawUrl);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const decision = evaluate({ method, url, body: init?.body });

    if (decision.intercept === false) return originalFetch(input, init);

    if (decision.intercept === 'rewrite') {
      const { overrides } = decision;
      const rewriteBody = resolveRewriteBody(overrides);
      return originalFetch(overrides.url ?? url, {
        ...init,
        ...(overrides.method !== undefined ? { method: overrides.method } : {}),
        ...(overrides.headers !== undefined
          ? { headers: { ...(init?.headers as Record<string, string> | undefined), ...overrides.headers } }
          : {}),
        ...(rewriteBody !== undefined ? { body: rewriteBody } : {}),
      });
    }

    const { response } = decision;
    if (response.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs));

    // Map, not object-spread, so a custom `content-type` override (any casing) replaces the
    // default instead of `Headers` treating them as two values for the same normalized name.
    const headers = new Map([['content-type', 'application/json']]);
    for (const [name, value] of Object.entries(response.headers ?? {})) headers.set(name.toLowerCase(), value);

    // 'base64' means bodyText is an uploaded file's raw bytes (fakeResponseFileInline), not text —
    // decode back to bytes so binary content survives intact instead of being sent as a base64
    // *string* (which is what the consuming page would actually receive if passed through as-is).
    const body: BodyInit = response.bodyEncoding === 'base64' ? new Blob([base64ToBytes(response.bodyText)]) : response.bodyText;

    return new Response(body, {
      status: response.status,
      ...(response.statusText !== undefined ? { statusText: response.statusText } : {}),
      headers: Object.fromEntries(headers),
    });
  };
}

function patchXhr(evaluate: EvaluateRequest): void {
  const OriginalXhr = window.XMLHttpRequest;
  const originalOpen = OriginalXhr.prototype.open;
  const originalSend = OriginalXhr.prototype.send;
  const originalSetRequestHeader = OriginalXhr.prototype.setRequestHeader;

  const state = new WeakMap<XMLHttpRequest, { method: string; url: string; openDecision: InterceptDecision }>();

  OriginalXhr.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    // First evaluation: body isn't known yet, so a match relying on `requestMatchContains` against
    // it can't be seen here — only enough to decide whether to override url/method before calling
    // the *real* open(), since that has to happen now or never (send()'s second evaluation, once
    // body is known, gets the final say on everything else — see there).
    const absoluteUrl = toAbsoluteUrl(url.toString());
    const openDecision = evaluate({ method, url: absoluteUrl });
    state.set(this, { method, url: absoluteUrl, openDecision });

    const openMethod = openDecision.intercept === 'rewrite' ? (openDecision.overrides.method ?? method) : method;
    const openUrl = openDecision.intercept === 'rewrite' ? (openDecision.overrides.url ?? url) : url;
    // `async` defaults to true per the XHR spec when omitted — normalize so every call goes
    // through the same overload (TypeScript's `.call()` typing only exposes one overload of
    // `open()` when the method is read off the prototype as a value).
    originalOpen.call(this, openMethod, openUrl, async ?? true, username ?? null, password ?? null);
  };

  OriginalXhr.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = state.get(this);
    // Second (final) evaluation: body is known now, so a rule matching on it (requestMatchContains)
    // gets a fair chance here. Its url/method overrides, if any, are moot — open() already
    // committed to whatever the *first* evaluation decided — only body/headers overrides and the
    // fake/pass branches below can still take effect at this point.
    const decision = meta ? evaluate({ method: meta.method, url: meta.url, body }) : { intercept: false as const };

    if (decision.intercept === false) {
      originalSend.call(this, body);
      return;
    }

    if (decision.intercept === 'rewrite') {
      const { overrides } = decision;
      if (overrides.headers) {
        // Must happen before send() — setRequestHeader() throws once the request has been sent.
        // Called *after* whatever headers the page's own code already set via the same method, so
        // these overrides win on a name collision.
        for (const [name, value] of Object.entries(overrides.headers)) {
          originalSetRequestHeader.call(this, name, value);
        }
      }
      const rewriteBody = resolveRewriteBody(overrides);
      originalSend.call(this, rewriteBody !== undefined ? (rewriteBody as XMLHttpRequestBodyInit) : body);
      return;
    }

    const { response } = decision;
    const deliver = () => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      for (const [name, value] of Object.entries(response.headers ?? {})) headers[name.toLowerCase()] = value;

      // Binary content (fakeResponseFileInline) needs `.response` to match whatever `responseType`
      // the caller asked for — unlike text, a byte string handed back as `responseText` would
      // corrupt it, and callers requesting a file almost always use 'arraybuffer'/'blob' anyway.
      let responseValue: unknown = response.bodyText;
      let responseTextValue = response.bodyText;
      if (response.bodyEncoding === 'base64') {
        const bytes = base64ToBytes(response.bodyText);
        if (this.responseType === 'arraybuffer') responseValue = bytes.buffer;
        else if (this.responseType === 'blob') responseValue = new Blob([bytes], { type: headers['content-type'] ?? 'application/json' });
        else responseTextValue = responseValue = new TextDecoder().decode(bytes);
      }

      Object.defineProperty(this, 'readyState', { value: 4, configurable: true });
      Object.defineProperty(this, 'status', { value: response.status, configurable: true });
      Object.defineProperty(this, 'statusText', { value: response.statusText ?? '', configurable: true });
      Object.defineProperty(this, 'responseText', { value: responseTextValue, configurable: true });
      Object.defineProperty(this, 'response', { value: responseValue, configurable: true });
      Object.defineProperty(this, 'getResponseHeader', {
        value: (name: string) => headers[name.toLowerCase()] ?? null,
        configurable: true,
      });
      Object.defineProperty(this, 'getAllResponseHeaders', {
        value: () => Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\r\n'),
        configurable: true,
      });
      this.dispatchEvent(new Event('readystatechange'));
      this.dispatchEvent(new Event('load'));
      this.dispatchEvent(new Event('loadend'));
    };

    if (response.delayMs) setTimeout(deliver, response.delayMs);
    else deliver();
  };
}
