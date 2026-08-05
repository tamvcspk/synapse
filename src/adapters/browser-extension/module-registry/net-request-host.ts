import { base64ToBytes, bytesToBase64 } from '../utils/blob-store';
import type { SynapseNetRequestOptions, SynapseNetResponse } from '../../../kernel/synapse-api';
import { findSecretByName } from '../features/secrets/secret-store.background';
import { resolveSecretForRequest, type SecretLookup } from './secret-resolution';

/**
 * Backs `synapseApi.net.request` (docs/api-inventory.md §2, "priority #1"). Runs in the background
 * service worker, where `fetch` reaches any origin under the extension's own identity thanks to
 * `manifest.config.ts`'s `host_permissions: ['<all_urls>']` — the delta a page-world script cannot
 * close on its own (`fetch` there is bound by the page's CORS, same reasoning as
 * `reader-mode-converter.module.ts`'s image fetch, docs/LESSONS.md).
 *
 * Match-pattern enforcement (which origins THIS script may reach) happens one layer up, in
 * `rpc-handler.ts`, before this function is ever called — by the time execution reaches here the
 * call is already authorized. This function only applies safety caps that protect the extension
 * itself (timeout, response size), which apply uniformly regardless of who is calling. The
 * `secrets.use` SCOPE gate (may this script reference a secret AT ALL) lives there too, for the
 * same reason — but a secret's own `allowedHost` binding (docs/ROADMAP.md §11.6) is a property of
 * the SECRET, not of the caller's grant, and belongs here instead: it must hold no matter which of
 * the three transports resolved the call, the same "applies uniformly regardless of who is calling"
 * bar the timeout/size caps below already clear.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
/** Matches the order of magnitude of other per-item caps already in the codebase (fetch-images
 * ~10MB/image, fakeResponseFile 2MB) rather than introducing a new number pulled from nowhere. */
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

export async function performNetRequest(
  options: SynapseNetRequestOptions,
  secretLookup: SecretLookup = findSecretByName,
): Promise<SynapseNetResponse> {
  if (typeof options?.url !== 'string' || options.url === '') {
    throw new Error('net.request: "url" is required');
  }

  const headers = await resolveHeaders(options.headers, options.url, secretLookup);

  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(options.url, requestInit(options, headers, controller.signal));

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_RESPONSE_BYTES) {
      throw new Error(`net.request: response exceeds the ${MAX_RESPONSE_BYTES}-byte cap`);
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const asBytes = options.responseType === 'arraybuffer';
    return {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: asBytes ? bytesToBase64(buffer) : new TextDecoder().decode(buffer),
      bodyEncoding: asBytes ? 'base64' : 'utf8',
      url: response.url,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`net.request: timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Built rather than a literal so `body`/`headers` can be OMITTED when absent — not set to
 * `undefined` — under this project's `exactOptionalPropertyTypes` (same convention documented at
 * docs/ROADMAP.md §2.6.1 for the same reason: `fetch`'s own types reject `body: undefined`). */
function requestInit(options: SynapseNetRequestOptions, headers: Record<string, string> | undefined, signal: AbortSignal): RequestInit {
  const init: RequestInit = { method: options.method ?? 'GET', signal };
  if (headers !== undefined) init.headers = headers;
  if (options.body !== undefined) {
    init.body = options.bodyEncoding === 'base64' ? base64ToBytes(options.body) : options.body;
  }
  return init;
}

/** Resolves every header value to a plain string before `fetch()` ever sees it — a `{secretRef}`
 * value (docs/ROADMAP.md §11.6) is looked up by name and substituted here, and the resolved value
 * never flows back out anywhere (not in `SynapseNetResponse`, not in a thrown message — only the
 * secret's NAME and its bound host pattern do, both safe to reveal). Fails closed on a missing
 * secret, a host mismatch, or a `format` with no `{}` placeholder to substitute into. */
async function resolveHeaders(
  headers: SynapseNetRequestOptions['headers'],
  requestUrl: string,
  secretLookup: SecretLookup,
): Promise<Record<string, string> | undefined> {
  if (headers === undefined) return undefined;

  const resolved: Record<string, string> = {};
  for (const [key, raw] of Object.entries(headers)) {
    if (typeof raw === 'string') {
      resolved[key] = raw;
      continue;
    }
    if (typeof raw !== 'object' || raw === null || typeof raw.secretRef !== 'string') {
      throw new Error(`net.request: header "${key}" must be a string or { secretRef }`);
    }

    const value = await resolveSecretForRequest('net.request', raw.secretRef, requestUrl, secretLookup);

    const format = raw.format ?? '{}';
    if (!format.includes('{}')) {
      throw new Error(`net.request: header "${key}"'s format must contain "{}"`);
    }
    resolved[key] = format.split('{}').join(value);
  }
  return resolved;
}
