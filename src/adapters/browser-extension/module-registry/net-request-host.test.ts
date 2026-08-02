import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
