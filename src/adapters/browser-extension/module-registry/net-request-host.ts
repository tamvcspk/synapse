import { base64ToBytes, bytesToBase64 } from '../utils/blob-store';
import type { SynapseNetRequestOptions, SynapseNetResponse } from '../../../kernel/synapse-api';

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
 * itself (timeout, response size), which apply uniformly regardless of who is calling.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
/** Matches the order of magnitude of other per-item caps already in the codebase (fetch-images
 * ~10MB/image, fakeResponseFile 2MB) rather than introducing a new number pulled from nowhere. */
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

export async function performNetRequest(options: SynapseNetRequestOptions): Promise<SynapseNetResponse> {
  if (typeof options?.url !== 'string' || options.url === '') {
    throw new Error('net.request: "url" is required');
  }

  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(options.url, requestInit(options, controller.signal));

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_RESPONSE_BYTES) {
      throw new Error(`net.request: response exceeds the ${MAX_RESPONSE_BYTES}-byte cap`);
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const asBytes = options.responseType === 'arraybuffer';
    return {
      status: response.status,
      statusText: response.statusText,
      headers,
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
function requestInit(options: SynapseNetRequestOptions, signal: AbortSignal): RequestInit {
  const init: RequestInit = { method: options.method ?? 'GET', signal };
  if (options.headers !== undefined) init.headers = options.headers;
  if (options.body !== undefined) {
    init.body = options.bodyEncoding === 'base64' ? base64ToBytes(options.body) : options.body;
  }
  return init;
}
