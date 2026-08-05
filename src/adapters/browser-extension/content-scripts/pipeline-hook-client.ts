import { createMainWorldChannel } from '../utils/main-world/event-channel';
import {
  PIPELINE_HOOK_FIRE_CHANNEL_ID,
  PIPELINE_HOOK_RESULT_CHANNEL_ID,
  PIPELINE_HOOK_WINNER_QUERY_MESSAGE_TYPE,
  type PipelineHookFirePayload,
  type PipelineHookResultPayload,
} from '../../../shared/pipeline-hook-bridge';

/**
 * The ISOLATED-world half of firing a Tier 2 slot (docs/ROADMAP.md §11.6 item 8) — called by
 * platform pipeline code (`dom-media-observer.content.ts`), never by a user script. Two hops, no
 * background involvement in the second one:
 *
 * 1. Ask background who (if anyone) wins this slot for this URL — a small dedicated
 *    `chrome.runtime.sendMessage` query (`PIPELINE_HOOK_WINNER_QUERY_MESSAGE_TYPE`), answered by
 *    `background/index.ts` from the persisted registry (`pipeline-hook-store.ts`).
 * 2. If there's a winner, dispatch the fire event directly on the shared `window` — ISOLATED and
 *    USER_SCRIPT share one `window` per tab, so this reaches the winning script's shim without a
 *    second background round trip (`createMainWorldChannel`, the same primitive
 *    `SUBSCRIPTION_PUSH_CHANNEL_ID` uses, proven ISOLATED→USER_SCRIPT on real Chrome) — and await its
 *    matching result event by `requestId`.
 *
 * Fails soft everywhere: no listener for the winner query (background restarted), no winner, or no
 * result within `timeoutMs` all resolve to `undefined` — a broken/slow/unhooked slot degrades to
 * "no override" for the caller, exactly like `createCompositeModule`'s per-step graceful-fail
 * philosophy, never a hang or a thrown error in the platform's own pipeline.
 */
const fireChannel = createMainWorldChannel<PipelineHookFirePayload>(PIPELINE_HOOK_FIRE_CHANNEL_ID);
const resultChannel = createMainWorldChannel<PipelineHookResultPayload>(PIPELINE_HOOK_RESULT_CHANNEL_ID);

const DEFAULT_TIMEOUT_MS = 3000;

/** `url` is what conflict resolution matches `match` patterns against (§11.6's "match cụ thể hơn
 * thắng" rule) — kept separate from `ctx` (the opaque payload handed to the winning script's
 * `handler`) since a future slot's `ctx` shape won't always simply be "the current page URL". */
export async function firePipelineHook(slotName: string, url: string, ctx: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
  let winner: { moduleId?: string } | undefined;
  try {
    winner = await chrome.runtime.sendMessage({ type: PIPELINE_HOOK_WINNER_QUERY_MESSAGE_TYPE, slotName, url });
  } catch {
    return undefined; // no listener (background just restarted) — same posture as every other best-effort relay
  }
  if (!winner?.moduleId) return undefined;

  const requestId = crypto.randomUUID();
  return new Promise<unknown>((resolve) => {
    let settled = false;
    const unsubscribe = resultChannel.onUpdate((payload) => {
      if (payload.requestId !== requestId || settled) return;
      settled = true;
      unsubscribe();
      resolve(payload.result);
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(undefined);
    }, timeoutMs);
    fireChannel.dispatch({ requestId, slotName, moduleId: winner!.moduleId!, ctx });
  });
}

/**
 * The registering-side counterpart, for the ISOLATED-world dom-Module transport (`rpc-client.ts`) —
 * the `user-script-shim.ts` template string re-implements the same shape by hand for the USER_SCRIPT
 * world, which cannot import this module (no ESM loader there, same reason `ui-compositor.ts` is
 * duplicated as a template string rather than imported — see that file's own doc comment).
 *
 * One listener per `moduleId`, answering every fire addressed to it regardless of which slot: looks
 * up the locally-registered handler via `getHandler(slotName)`, invokes it, and always dispatches a
 * result (even on throw/reject — `undefined`, never lets a bad handler leave the firer's promise
 * hanging past its own timeout).
 */
export function installPipelineHookResponder(
  moduleId: string,
  getHandler: (slotName: string) => ((ctx: unknown) => unknown) | undefined,
): () => void {
  return fireChannel.onUpdate((payload) => {
    if (payload.moduleId !== moduleId) return;
    const handler = getHandler(payload.slotName);
    if (!handler) return;
    void Promise.resolve()
      .then(() => handler(payload.ctx))
      .catch(() => undefined)
      .then((result) => resultChannel.dispatch({ requestId: payload.requestId, result }));
  });
}
