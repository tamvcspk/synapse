import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SecretRecord } from '../../../shared/secrets';
import { performAiAsk } from './ai-ask-host';

/**
 * `fetch` is mocked rather than hitting a real provider — the `net.request` scope+match ENFORCEMENT
 * `ai.ask` is gated on is covered by scopes.test.ts, and the `secrets.use` gate lives in
 * rpc-handler.ts (same division of labor net-request-host.test.ts's own header comment describes).
 * This file only pins what performAiAsk itself does: which endpoint/body shape each provider gets,
 * how the reply text is extracted, and the secret→Authorization-header wiring.
 */
describe('performAiAsk', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const messages = [{ role: 'user' as const, content: 'hi' }];

  it('rejects an unknown provider before ever calling fetch', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      performAiAsk({ provider: 'anthropic' as unknown as 'openai', model: 'x', messages }),
    ).rejects.toThrow(/"provider" must be "openai" or "ollama"/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a missing model', async () => {
    await expect(performAiAsk({ provider: 'openai', model: '', messages })).rejects.toThrow(/"model" is required/);
  });

  it('rejects empty/missing messages', async () => {
    await expect(performAiAsk({ provider: 'openai', model: 'gpt-4o-mini', messages: [] })).rejects.toThrow(
      /"messages" must be a non-empty array/,
    );
  });

  it('posts to the OpenAI chat-completions endpoint by default and extracts choices[0].message.content', async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toEqual({ model: 'gpt-4o-mini', messages });
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hello!' } }] }));
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await performAiAsk({ provider: 'openai', model: 'gpt-4o-mini', messages });

    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/chat/completions');
    expect(result).toEqual({ text: 'hello!' });
  });

  it('posts to the Ollama chat endpoint by default, with stream:false, and extracts message.content', async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toEqual({ model: 'llama3', messages, stream: false });
      return new Response(JSON.stringify({ message: { role: 'assistant', content: 'hi there' } }));
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await performAiAsk({ provider: 'ollama', model: 'llama3', messages });

    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://localhost:11434/api/chat');
    expect(result).toEqual({ text: 'hi there' });
  });

  it('respects an explicit baseUrl override instead of the provider default', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ message: { content: 'ok' } })),
    ) as unknown as typeof fetch;

    await performAiAsk({ provider: 'ollama', model: 'llama3', messages, baseUrl: 'http://my-box:11434/api/chat' });

    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      'http://my-box:11434/api/chat',
    );
  });

  it('surfaces a non-2xx response as a thrown error with the status and a body snippet', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('{"error":"bad key"}', { status: 401, statusText: 'Unauthorized' }),
    ) as unknown as typeof fetch;

    await expect(performAiAsk({ provider: 'openai', model: 'gpt-4o-mini', messages })).rejects.toThrow(
      /openai responded 401 Unauthorized.*bad key/,
    );
  });

  it('throws when the response is not the expected shape, rather than returning undefined text', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ nope: true }))) as unknown as typeof fetch;

    await expect(performAiAsk({ provider: 'openai', model: 'gpt-4o-mini', messages })).rejects.toThrow(
      /could not find a reply/,
    );
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

    await expect(
      performAiAsk({ provider: 'openai', model: 'gpt-4o-mini', messages, timeoutMs: 5 }),
    ).rejects.toThrow(/timed out after 5ms/);
  });
});

/**
 * secretRef → Authorization header (docs/ROADMAP.md §11.6) — the `secrets.use` SCOPE gate lives in
 * rpc-handler.ts, not here; these tests cover what performAiAsk itself does once a call has already
 * cleared that gate. Same DI shape net-request-host.test.ts uses for the same reason: `secretLookup`
 * is injected so none of this touches chrome.storage.local.
 */
describe('performAiAsk — secretRef (docs/ROADMAP.md §11.6)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const messages = [{ role: 'user' as const, content: 'hi' }];
  const secret: SecretRecord = {
    id: 's1',
    name: 'my-openai-key',
    value: 'sk-secret-value',
    allowedHost: 'https://api.openai.com/*',
    createdAt: 0,
    updatedAt: 0,
  };
  const lookup = (name: string): Promise<SecretRecord | undefined> =>
    Promise.resolve(name === secret.name ? secret : undefined);

  it('injects the resolved secret as an Authorization: Bearer header', async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sk-secret-value');
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await performAiAsk({ provider: 'openai', model: 'gpt-4o-mini', messages, secretRef: 'my-openai-key' }, lookup);
  });

  it('rejects, before ever calling fetch, when the referenced secret does not exist', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      performAiAsk({ provider: 'openai', model: 'gpt-4o-mini', messages, secretRef: 'nope' }, lookup),
    ).rejects.toThrow(/secret "nope" does not exist/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects, before ever calling fetch, when the resolved endpoint falls outside the secret's own allowedHost", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      performAiAsk({ provider: 'ollama', model: 'llama3', messages, secretRef: 'my-openai-key' }, lookup),
    ).rejects.toThrow(/is bound to "https:\/\/api\.openai\.com\/\*"/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never leaks the resolved secret value into a thrown downstream-failure message', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('{"error":"unauthorized"}', { status: 401, statusText: 'Unauthorized' }),
    ) as unknown as typeof fetch;

    await expect(
      performAiAsk({ provider: 'openai', model: 'gpt-4o-mini', messages, secretRef: 'my-openai-key' }, lookup),
    ).rejects.toThrow(/^(?!.*sk-secret-value).*$/s);
  });
});
