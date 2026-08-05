import { matchesUrlPattern } from './match-pattern';

/**
 * Tier 2 composition (docs/ROADMAP.md §11.6 item 8, `.claude/skills/userscript-api`'s "Composition"
 * section): a platform pipeline running in ISOLATED-world content-script code (e.g.
 * `dom-media-observer.content.ts`) fires a named *slot*; a user script running in the USER_SCRIPT
 * world may have registered a `handler` closure for that slot. A function can never cross
 * `chrome.runtime.sendMessage`'s structured-clone boundary, so — same shape as `media.onProgress`
 * (`subscription-bridge.ts`), one hop further because a pipeline step needs the handler's *return
 * value*, not just a push — only serializable data crosses:
 *
 *   ISOLATED world                                    USER_SCRIPT world
 *     dispatch(PIPELINE_HOOK_FIRE_CHANNEL_ID, {requestId, slotName, moduleId, ctx})
 *                                                        → winning script's shim invokes its own
 *                                                          locally-registered handler(ctx)
 *     ← dispatch(PIPELINE_HOOK_RESULT_CHANNEL_ID, {requestId, result})
 *
 * Both channel ids are plain DOM `CustomEvent` names on the shared `window`
 * (`utils/main-world/event-channel.ts`'s `createMainWorldChannel`, the same primitive
 * `SUBSCRIPTION_PUSH_CHANNEL_ID` uses, confirmed working ISOLATED→USER_SCRIPT on real Chrome per
 * `user-script-shim.ts`'s doc comment) — no background hop needed for the fire/result round trip
 * itself, since the pipeline and the script share one tab's `window`. The background IS involved,
 * separately, for *registration* (`pipeline.register`, RPC, scope-checked, persisted) and for
 * *who-wins* resolution before firing (the ISOLATED-world caller asks background "who wins slot X
 * for this URL", then dispatches the fire event addressed to that one `moduleId` only).
 */
export const PIPELINE_HOOK_FIRE_CHANNEL_ID = 'synapse:pipeline-hook-fire';
export const PIPELINE_HOOK_RESULT_CHANNEL_ID = 'synapse:pipeline-hook-result';

/** `chrome.runtime.sendMessage` type tag for the ISOLATED-world "who wins slot X for this URL"
 * query — a small dedicated message shape, not the generic `synapse:rpc` envelope, because the
 * caller here is platform code (a content script), not a user script going through the facade. */
export const PIPELINE_HOOK_WINNER_QUERY_MESSAGE_TYPE = 'synapse:pipeline-hook-winner';

export interface PipelineHookFirePayload {
  requestId: string;
  slotName: string;
  moduleId: string;
  ctx: unknown;
}

export interface PipelineHookResultPayload {
  requestId: string;
  result: unknown;
}

/** The only slots that exist today — `pipeline.register` rejects anything else, fail-closed, same
 * posture as `API_METHODS` rejecting an unknown namespace/method. Extend this when a second slot
 * ships (docs/ROADMAP.md §11.6 names `[§10.2]`/`[§10.3]` as future candidates once those features
 * themselves exist — neither does yet). */
export const KNOWN_PIPELINE_SLOTS = ['media.correlate-url'] as const;
export type PipelineSlotName = (typeof KNOWN_PIPELINE_SLOTS)[number];

export function isKnownPipelineSlot(slotName: string): slotName is PipelineSlotName {
  return (KNOWN_PIPELINE_SLOTS as readonly string[]).includes(slotName);
}

/** A registered hook, as persisted by `pipeline-hook-store.ts` and as returned to the ISOLATED-world
 * caller for local winner resolution — one record per `(ownerModuleId, slotName)` (upsert, not
 * accumulate; see that file's doc comment for why this deliberately differs from `net.mock`). */
export interface PipelineHookRecord {
  ownerModuleId: string;
  slotName: string;
  match: string[];
}

/** More literal (non-wildcard) characters in a pattern = more specific — a bare scheme+wildcard
 * pattern scores 0, a wildcarded subdomain pattern scores higher, and a fully literal host+path
 * pattern scores highest. A v1 heuristic (documented in the plan as refinable later), good enough to
 * satisfy §11.6's "match cụ thể hơn thắng" rule without inventing a full match-pattern partial-order. */
function matchSpecificityScore(pattern: string): number {
  return pattern.replace(/\*/g, '').length;
}

/** The best (most specific) of a record's own match patterns that actually matches `url`, or
 * `undefined` if none of them do — a record with several patterns is scored by its best one, not
 * its worst. */
function bestScoreForUrl(record: PipelineHookRecord, url: string): number | undefined {
  let best: number | undefined;
  for (const pattern of record.match) {
    if (!matchesUrlPattern(url, pattern)) continue;
    const score = matchSpecificityScore(pattern);
    if (best === undefined || score > best) best = score;
  }
  return best;
}

/**
 * §11.6's conflict rule, verbatim: most-specific `match` wins; ties broken by user-configured order;
 * **never** registration order (candidates are not assumed to arrive in any meaningful order here).
 *
 * There is no per-slot reorder UI anywhere in the product yet, so "user-configured order" has no
 * real setting to read today. The placeholder tie-break is alphabetical by whatever label
 * `labelFor` resolves for each candidate's `ownerModuleId` — the same "deterministic without being
 * registration order" placeholder already used for the identical problem in icon ordering
 * (docs/ROADMAP.md's icon-ordering Open Point, `resolveScriptLabel`). `labelFor` is injected rather
 * than computed here so this file stays free of chrome/storage — the caller (background, which has
 * already read script metadata to answer the winner query) resolves labels once and passes them in.
 */
export function resolveHookWinner<T extends PipelineHookRecord>(
  candidates: T[],
  url: string,
  labelFor: (moduleId: string) => string,
): T | undefined {
  let winner: T | undefined;
  let winnerScore = -1;
  let winnerLabel = '';
  for (const candidate of candidates) {
    const score = bestScoreForUrl(candidate, url);
    if (score === undefined) continue;
    const label = labelFor(candidate.ownerModuleId);
    if (winner === undefined || score > winnerScore || (score === winnerScore && label < winnerLabel)) {
      winner = candidate;
      winnerScore = score;
      winnerLabel = label;
    }
  }
  return winner;
}
