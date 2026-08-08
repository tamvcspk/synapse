import type { RpcRequest, RpcResponse } from '../../../kernel/rpc';
import type {
  SynapseAiAskOptions,
  SynapseAiAskResult,
  SynapseApi,
  SynapseFilesSaveOptions,
  SynapseFilesSaveResult,
  SynapseMediaControlAction,
  SynapseMediaDownloadOptions,
  SynapseMediaEntry,
  SynapseMediaInspectResult,
  SynapseMediaJobStatus,
  SynapseMockRule,
  SynapseMockRuleOptions,
  SynapseNetRequestOptions,
  SynapseNetResponse,
  SynapsePipelineHookOptions,
} from '../../../kernel/synapse-api';
import { htmlToMarkdown } from '../../../shared/html-to-markdown';
import { isValidMatchPattern, matchesAnyPattern, matchesUrlPattern } from '../../../shared/match-pattern';
import { parseM3u8 } from '../../../shared/media-manifest-parser';
import { SUBSCRIPTION_PUSH_CHANNEL_ID, type SubscriptionPushPayload } from '../../../shared/subscription-bridge';
import { buildZip } from '../../../shared/zip';
import { readable } from '../module-registry/lib-readable';
import { createMainWorldChannel } from '../utils/main-world/event-channel';
import { installPipelineHookResponder } from './pipeline-hook-client';
import { createUiSurface } from '../utils/ui-compositor';

// docs/api-inventory.md §6 item 8 — the same DOM-CustomEvent channel content-scripts/index.ts
// relays a background push onto; `media.onProgress` below is this transport's own in-world listener
// on it, exactly the shape `synapseApi.ui` already uses for its content-script implementation.
const subscriptionPushChannel = createMainWorldChannel<SubscriptionPushPayload>(SUBSCRIPTION_PUSH_CHANNEL_ID);

// lib.* (docs/api-inventory.md §3.0) — this is the extension's own ISOLATED-world bundle, an
// ordinary ESM context, so it imports the real functions directly rather than needing the
// `?script&iife` + `{file}` delivery the USER_SCRIPT-world shim requires (user-script-shim.ts).
const lib = {
  hls: { parse: parseM3u8 },
  readable,
  toMarkdown: htmlToMarkdown,
  zip: buildZip,
  matchPattern: { isValid: isValidMatchPattern, test: matchesUrlPattern, testAny: matchesAnyPattern },
};

/**
 * Content-script-side transport for `synapseApi` (docs/ROADMAP.md §11.3) — the counterpart to
 * module-registry/rpc-handler.ts, and the same wire protocol the uploaded-script shim uses
 * (user-script-shim.ts). A bundled `dom` Module gets this as `ctx.api` (see relay.ts) so all three
 * transports expose one interface; a method present on one and missing from another is a contract
 * break, not a gap.
 *
 * The old `buildDomModuleServices` this replaces handed back `ai`/`cache` Kernel Services from the
 * retired Capability model. `bus` was never proxied here for a reason worth keeping in mind when
 * extending this file: a handler function cannot cross `chrome.runtime.sendMessage`'s
 * structured-clone boundary, so any future subscription must register its handler locally here and
 * only push serializable events across.
 */
/**
 * The reply arrives as `sendMessage`'s own resolved value — `rpc-handler.ts` answers with
 * `sendResponse()`, which resolves the sender's promise rather than broadcasting anything. This
 * file used to instead listen for an inbound `'synapse:rpc-result'` message that nothing ever
 * sends, so every call hung forever, silently, in both transports. Awaiting the promise is the fix.
 */
async function call(
  moduleId: string,
  namespace: RpcRequest['namespace'],
  method: string,
  args: unknown[],
): Promise<unknown> {
  const request: RpcRequest = { type: 'synapse:rpc', callId: crypto.randomUUID(), moduleId, namespace, method, args };
  const response = (await chrome.runtime.sendMessage(request)) as RpcResponse | undefined;
  if (!response) throw new Error('Synapse: no response from the extension background (was it reloaded?)');
  if (response.error) throw new Error(response.error);
  return response.result;
}

/** Builds `ctx.api` for a bundled dom Module, backed by the RPC bridge. Calls are still checked
 * against the Module's granted scopes in background — a content script is not a trust boundary.
 *
 * `ui` is the exception that proves the shape: it does NOT go over the bridge (docs/ROADMAP.md
 * §11.0 — an engine behind a message boundary cannot take `onClick`), so it is wired straight to the
 * in-world compositor here, with the same `moduleId` this function was given. Identity still comes
 * from the caller of THIS function (the composition root), never from the Module's own code. */
export function buildDomModuleApi(moduleId: string): SynapseApi {
  // docs/ROADMAP.md §11.6 item 8 (Tier 2 pipeline hooks) — one responder per Module, answering every
  // fire addressed to this moduleId regardless of which slot; `pipeline.hook` below just populates
  // this map, it never installs a second listener.
  const pipelineHooks = new Map<string, (ctx: unknown) => unknown>();
  installPipelineHookResponder(moduleId, (slotName) => pipelineHooks.get(slotName));

  return {
    storage: {
      get: (key) => call(moduleId, 'storage', 'get', [key]),
      set: (key, value) => call(moduleId, 'storage', 'set', [key, value]).then(() => undefined),
      remove: (key) => call(moduleId, 'storage', 'remove', [key]).then(() => undefined),
      keys: () => call(moduleId, 'storage', 'keys', []) as Promise<string[]>,
      tab: {
        get: (key) => call(moduleId, 'storage', 'tab.get', [key]),
        set: (key, value) => call(moduleId, 'storage', 'tab.set', [key, value]).then(() => undefined),
        remove: (key) => call(moduleId, 'storage', 'tab.remove', [key]).then(() => undefined),
        keys: () => call(moduleId, 'storage', 'tab.keys', []) as Promise<string[]>,
      },
      session: {
        get: (key) => call(moduleId, 'storage', 'session.get', [key]),
        set: (key, value) => call(moduleId, 'storage', 'session.set', [key, value]).then(() => undefined),
        remove: (key) => call(moduleId, 'storage', 'session.remove', [key]).then(() => undefined),
        keys: () => call(moduleId, 'storage', 'session.keys', []) as Promise<string[]>,
      },
    },
    ui: createUiSurface(moduleId),
    net: {
      request: (options: SynapseNetRequestOptions) =>
        call(moduleId, 'net', 'request', [options]) as Promise<SynapseNetResponse>,
      mock: {
        add: (options: SynapseMockRuleOptions) => call(moduleId, 'net', 'mock.add', [options]) as Promise<{ id: string }>,
        remove: (id: string) => call(moduleId, 'net', 'mock.remove', [id]).then(() => undefined),
        list: () => call(moduleId, 'net', 'mock.list', []) as Promise<SynapseMockRule[]>,
      },
    },
    files: {
      save: (options: SynapseFilesSaveOptions) =>
        call(moduleId, 'files', 'save', [options]) as Promise<SynapseFilesSaveResult>,
    },
    lib,
    media: {
      list: () => call(moduleId, 'media', 'list', []) as Promise<SynapseMediaEntry[]>,
      inspect: (url: string) => call(moduleId, 'media', 'inspect', [url]) as Promise<SynapseMediaInspectResult>,
      download: (options: SynapseMediaDownloadOptions) => call(moduleId, 'media', 'download', [options]) as Promise<string>,
      job: (jobId: string) => call(moduleId, 'media', 'job', [jobId]) as Promise<SynapseMediaJobStatus | undefined>,
      control: (jobId: string, action: SynapseMediaControlAction) =>
        call(moduleId, 'media', 'control', [jobId, action]).then(() => undefined),
      onProgress: (jobId: string, handler: (status: SynapseMediaJobStatus) => void) => {
        const topic = `media.progress:${jobId}`;
        return subscriptionPushChannel.onUpdate((payload) => {
          if (payload.topic === topic) handler(payload.data as SynapseMediaJobStatus);
        });
      },
    },
    page: {
      eval: (code: string, args?: unknown[]) => call(moduleId, 'page', 'eval', [code, args]),
    },
    ai: {
      ask: (options: SynapseAiAskOptions) => call(moduleId, 'ai', 'ask', [options]) as Promise<SynapseAiAskResult>,
    },
    pipeline: {
      hook: async (slotName: 'media.correlate-url', options: SynapsePipelineHookOptions) => {
        await call(moduleId, 'pipeline', 'register', [slotName, { match: options.match }]);
        pipelineHooks.set(slotName, options.handler as (ctx: unknown) => unknown);
        return () => {
          pipelineHooks.delete(slotName);
          void call(moduleId, 'pipeline', 'unregister', [slotName]).catch(() => {});
        };
      },
    },
  };
}
