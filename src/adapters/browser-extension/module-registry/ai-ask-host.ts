import type { SynapseAiAskOptions, SynapseAiAskResult } from '../../../kernel/synapse-api';
import { findSecretByName } from '../features/secrets/secret-store.background';
import { resolveSecretForRequest, type SecretLookup } from './secret-resolution';

/**
 * Backs `synapseApi.ai.ask` (docs/ROADMAP.md §11.6) — a thin `{provider, model, messages} → text`
 * helper, not an agent and not a unified LLM abstraction (see the type's own doc comment in
 * `kernel/synapse-api.ts` for why that line is drawn deliberately). Runs in the background service
 * worker for the same reason `net-request-host.ts` does: `fetch` here reaches any origin under the
 * extension's identity, not the page's CORS.
 *
 * Gated on `net.request`'s own scope+match (`kernel/scopes.ts`), not a scope of its own — this
 * function does not open any door `net.request` + `secretRef` didn't already open, it only shapes
 * the request and extracts the reply text. `secrets.use` is checked the same way it is for
 * `net.request`'s header values, one layer up in `rpc-handler.ts`; this function only resolves the
 * secret's own `allowedHost` binding (`secret-resolution.ts`), the same division of labor
 * `net-request-host.ts`'s doc comment describes.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

const DEFAULT_ENDPOINT: Record<SynapseAiAskOptions['provider'], string> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  ollama: 'http://localhost:11434/api/chat',
};

export async function performAiAsk(
  options: SynapseAiAskOptions,
  secretLookup: SecretLookup = findSecretByName,
): Promise<SynapseAiAskResult> {
  if (options?.provider !== 'openai' && options?.provider !== 'ollama') {
    throw new Error('ai.ask: "provider" must be "openai" or "ollama"');
  }
  if (typeof options.model !== 'string' || options.model === '') {
    throw new Error('ai.ask: "model" is required');
  }
  if (!Array.isArray(options.messages) || options.messages.length === 0) {
    throw new Error('ai.ask: "messages" must be a non-empty array');
  }

  const url = options.baseUrl ?? DEFAULT_ENDPOINT[options.provider];

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.secretRef !== undefined) {
    const value = await resolveSecretForRequest('ai.ask', options.secretRef, url, secretLookup);
    headers.authorization = `Bearer ${value}`;
  }

  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody(options)),
      signal: controller.signal,
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`ai.ask: ${options.provider} responded ${response.status} ${response.statusText}: ${bodyText.slice(0, 500)}`);
    }

    return { text: extractText(options.provider, bodyText) };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`ai.ask: timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function requestBody(options: SynapseAiAskOptions): unknown {
  if (options.provider === 'openai') {
    return { model: options.model, messages: options.messages };
  }
  // Ollama's /api/chat streams newline-delimited JSON by default — stream:false collapses it to
  // one JSON object, the shape extractText below expects.
  return { model: options.model, messages: options.messages, stream: false };
}

function extractText(provider: SynapseAiAskOptions['provider'], bodyText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error(`ai.ask: ${provider} response was not valid JSON`);
  }

  const text =
    provider === 'openai'
      ? (parsed as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content
      : (parsed as { message?: { content?: unknown } })?.message?.content;

  if (typeof text !== 'string') {
    throw new Error(`ai.ask: could not find a reply in ${provider}'s response shape`);
  }
  return text;
}
