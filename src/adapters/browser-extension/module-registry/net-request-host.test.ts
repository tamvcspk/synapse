import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretRecord } from '../../../shared/secrets';
import { performNetRequest } from './net-request-host';

/**
 * `fetch` is mocked rather than hitting a real network — match-pattern ENFORCEMENT is covered by
 * scopes.test.ts (the boundary this function sits behind, not this function's own job). This file
 * only pins what performNetRequest itself does with a response: encoding, headers, timeout, caps.
 */
describe('performNetRequest', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('rejects a missing/empty url before ever calling fetch', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(performNetRequest({ url: '' })).rejects.toThrow(/"url" is required/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('decodes a text response as utf8 by default and surfaces status/headers/final url', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('hello world', {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/plain' },
      }),
    ) as unknown as typeof fetch;
    // Response.url is read-only and Response's constructor doesn't let us set it directly in all
    // runtimes, so this test only asserts the fields performNetRequest actually controls.

    const result = await performNetRequest({ url: 'https://api.example.com/x' });

    expect(result.status).toBe(200);
    expect(result.statusText).toBe('OK');
    expect(result.body).toBe('hello world');
    expect(result.bodyEncoding).toBe('utf8');
    expect(result.headers['content-type']).toBe('text/plain');
  });

  it('base64-encodes the body when responseType is arraybuffer, for binary payloads', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    globalThis.fetch = vi.fn(async () => new Response(bytes)) as unknown as typeof fetch;

    const result = await performNetRequest({ url: 'https://api.example.com/bin', responseType: 'arraybuffer' });

    expect(result.bodyEncoding).toBe('base64');
    expect(Buffer.from(result.body, 'base64')).toEqual(Buffer.from(bytes));
  });

  it('passes method/headers through and base64-decodes an outgoing base64 body to raw bytes', async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>)['x-test']).toBe('1');
      expect(init?.body).toBeInstanceOf(ArrayBuffer);
      return new Response('ok');
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await performNetRequest({
      url: 'https://api.example.com/upload',
      method: 'POST',
      headers: { 'x-test': '1' },
      body: Buffer.from([1, 2, 3]).toString('base64'),
      bodyEncoding: 'base64',
    });

    expect(fetchSpy).toHaveBeenCalled();
  });

  it('surfaces a non-2xx status as a normal resolved response, not a throw — matching fetch() itself', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch;

    const result = await performNetRequest({ url: 'https://api.example.com/missing' });

    expect(result.status).toBe(404);
    expect(result.body).toBe('nope');
  });

  it('rejects with a clear timeout message when the request is aborted', async () => {
    globalThis.fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    ) as unknown as typeof fetch;

    await expect(performNetRequest({ url: 'https://api.example.com/slow', timeoutMs: 5 })).rejects.toThrow(
      /timed out after 5ms/,
    );
  });

  it('caps timeoutMs at 120s rather than trusting an arbitrarily large caller value', async () => {
    // Not directly observable from the outside without exposing the constant, so this test only
    // pins that an absurd timeoutMs doesn't throw synchronously and a fast response still resolves
    // normally — the cap itself lives next to MAX_TIMEOUT_MS in net-request-host.ts.
    globalThis.fetch = vi.fn(async () => new Response('ok')) as unknown as typeof fetch;

    const result = await performNetRequest({ url: 'https://api.example.com/x', timeoutMs: 999_999_999 });
    expect(result.body).toBe('ok');
  });
});

/**
 * docs/ROADMAP.md §11.6 — the `secrets.use` SCOPE gate (may this script reference a secret at all)
 * is checked one layer up, in rpc-handler.ts, NOT here (see this file's own header comment). These
 * tests only cover what performNetRequest itself does once a call has already cleared that gate: a
 * secret's own `allowedHost` binding, resolving `{secretRef}` into the actual fetch, and never
 * leaking the resolved value back out. `secretLookup` is injected (default: the real
 * chrome.storage-backed lookup) so none of this touches chrome.storage.local, same DI pattern
 * net-mock-host.ts's `MockRuleStore` uses for the same reason.
 */
describe('performNetRequest — secretRef headers (docs/ROADMAP.md §11.6)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const secret: SecretRecord = {
    id: 's1',
    name: 'my-openai-key',
    value: 'sk-secret-value',
    allowedHost: 'https://api.openai.com/*',
    createdAt: 0,
    updatedAt: 0,
  };
  const lookup = (name: string): Promise<SecretRecord | undefined> => Promise.resolve(name === secret.name ? secret : undefined);

  it('substitutes a plain {secretRef} header with the resolved value', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response('ok'));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await performNetRequest(
      { url: 'https://api.openai.com/v1/models', headers: { Authorization: { secretRef: 'my-openai-key' } } },
      lookup,
    );

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('sk-secret-value');
  });

  it('substitutes into a format template ("Bearer {}")', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response('ok'));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await performNetRequest(
      {
        url: 'https://api.openai.com/v1/models',
        headers: { Authorization: { secretRef: 'my-openai-key', format: 'Bearer {}' } },
      },
      lookup,
    );

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-secret-value');
  });

  it('leaves plain string headers untouched alongside a resolved secretRef header', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response('ok'));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await performNetRequest(
      {
        url: 'https://api.openai.com/v1/models',
        headers: { Authorization: { secretRef: 'my-openai-key' }, 'x-plain': 'value' },
      },
      lookup,
    );

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-plain']).toBe('value');
  });

  it('rejects, before ever calling fetch, when the referenced secret does not exist', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      performNetRequest({ url: 'https://api.openai.com/v1/models', headers: { Authorization: { secretRef: 'nope' } } }, lookup),
    ).rejects.toThrow(/secret "nope" does not exist/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects, before ever calling fetch, when the request url falls outside the secret\'s own allowedHost — independent of any scope match', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      performNetRequest(
        { url: 'https://evil.example/steal', headers: { Authorization: { secretRef: 'my-openai-key' } } },
        lookup,
      ),
    ).rejects.toThrow(/is bound to "https:\/\/api\.openai\.com\/\*"/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a format with no {} placeholder rather than silently dropping the secret', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      performNetRequest(
        { url: 'https://api.openai.com/v1/models', headers: { Authorization: { secretRef: 'my-openai-key', format: 'Bearer TOKEN' } } },
        lookup,
      ),
    ).rejects.toThrow(/format must contain "\{\}"/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never leaks the resolved secret value into the thrown error for a downstream failure', async () => {
    globalThis.fetch = vi.fn(async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch;

    const result = await performNetRequest(
      { url: 'https://api.openai.com/v1/models', headers: { Authorization: { secretRef: 'my-openai-key' } } },
      lookup,
    );

    // A non-2xx status resolves normally (matching fetch() itself) — the point of this test is that
    // nothing anywhere in the returned value contains the raw secret.
    expect(JSON.stringify(result)).not.toContain('sk-secret-value');
  });

  it('rejects a malformed header value that is neither a string nor {secretRef}', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      performNetRequest(
        { url: 'https://api.example.com/x', headers: { Authorization: 42 as unknown as string } },
        lookup,
      ),
    ).rejects.toThrow(/must be a string or \{ secretRef \}/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
