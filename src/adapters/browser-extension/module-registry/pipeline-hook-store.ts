import type { CacheService } from '../../../kernel/module';
import { chromeStorageCache } from '../background/services/cache';
import { isValidMatchPattern } from '../../../shared/match-pattern';
import { isKnownPipelineSlot, resolveHookWinner, type PipelineHookRecord } from '../../../shared/pipeline-hook-bridge';

/**
 * Backs `pipeline.register`/`pipeline.hook` (docs/ROADMAP.md §11.6 item 8, `.claude/skills/userscript-api`
 * "Composition" §Tier 2) — the persisted half of a hook registration. Same DI-around-`CacheService`
 * shape `mock-config-store.background.ts` uses (not `net-mock-host.ts`'s bespoke `MockRuleStore`
 * interface, since there's no second interception mechanism here to `sync()` — a hook registration
 * is pure data until something fires the slot and asks who wins, unlike a mock rule which is
 * enforced passively by a MAIN-world patch the moment it's saved).
 *
 * **Upsert by `(ownerModuleId, slotName)`, not accumulate** — deliberately different from
 * `net-mock-host.ts`'s `performMockAdd`, which appends a new rule on every call (a script legitimately
 * wants several distinct endpoint rules). A pipeline hook is one script's standing claim on one named
 * slot: `pipeline.hook()` is meant to be called once at the top of a script (fresh on every page
 * load, since USER_SCRIPT-world code re-evaluates per navigation), and a script wanting different
 * behavior per site branches inside its own `handler`, using `match` to scope where the hook even
 * applies — not by registering the same slot twice. Accumulating here would leave stale duplicate
 * records piling up across page loads with no way for the script to ever clean them up.
 */
export interface PipelineHookStore {
  list(): Promise<PipelineHookRecord[]>;
  save(records: PipelineHookRecord[]): Promise<void>;
}

const STORAGE_KEY = 'synapse:pipeline-hooks';

function realStore(cache: CacheService): PipelineHookStore {
  return {
    list: async () => ((await cache.get(STORAGE_KEY)) as PipelineHookRecord[] | undefined) ?? [],
    save: async (records) => {
      await cache.set(STORAGE_KEY, records);
    },
  };
}

export interface PipelineHookRegisterOptions {
  match: string[];
}

/** Fail-closed on both dimensions: an unknown `slotName` (the only real allowlist — see
 * `KNOWN_PIPELINE_SLOTS`' own doc comment for why v1 has exactly one) and a `match` array that isn't
 * every entry a valid Chrome-syntax pattern (`isValidMatchPattern`, the same parser
 * `net-request-host.ts`/`scopes.ts` use — never a bespoke glob). Scope enforcement itself
 * (`media`, reused rather than a new one — see the plan) happens one layer up in `rpc-handler.ts`,
 * same as every other `requiresMatch: false` scope's method; this function only validates the
 * call's own argument shape, same division of labor `net-mock-host.ts#performMockAdd` already has. */
export async function performHookRegister(
  moduleId: string,
  slotName: unknown,
  options: PipelineHookRegisterOptions,
  store: PipelineHookStore = realStore(chromeStorageCache),
): Promise<void> {
  if (typeof slotName !== 'string' || !isKnownPipelineSlot(slotName)) {
    throw new Error(`pipeline.register: unknown slot "${String(slotName)}"`);
  }
  const match = options?.match;
  if (!Array.isArray(match) || match.length === 0 || !match.every((p) => typeof p === 'string' && isValidMatchPattern(p))) {
    throw new Error('pipeline.register: "match" must be a non-empty array of valid match patterns');
  }

  const records = await store.list();
  const next = records.filter((r) => !(r.ownerModuleId === moduleId && r.slotName === slotName));
  next.push({ ownerModuleId: moduleId, slotName, match: [...match] });
  await store.save(next);
}

/** Called when a script's own teardown wants to release a slot early (returned as the unsubscribe
 * function from `synapseApi.pipeline.hook()`) — not required for correctness (a fresh page load
 * upserts anyway) but avoids a stale registration answering "who wins" for a script that has since
 * unregistered without navigating away. */
export async function performHookUnregister(
  moduleId: string,
  slotName: string,
  store: PipelineHookStore = realStore(chromeStorageCache),
): Promise<void> {
  const records = await store.list();
  await store.save(records.filter((r) => !(r.ownerModuleId === moduleId && r.slotName === slotName)));
}

/** Answers the ISOLATED-world "who wins slot X for this URL" query
 * (`pipeline-hook-client.ts`/`PIPELINE_HOOK_WINNER_QUERY_MESSAGE_TYPE`) — filters the persisted
 * registry down to this slot, then defers to `resolveHookWinner`'s pure conflict-resolution rule.
 * `labelFor` is injected by the caller (the background message handler, which is the one place that
 * already needs to read script metadata) so this file stays testable without chrome.storage-backed
 * label resolution wired in. */
export async function resolveHookWinnerForSlot(
  slotName: string,
  url: string,
  labelFor: (moduleId: string) => string,
  store: PipelineHookStore = realStore(chromeStorageCache),
): Promise<{ moduleId: string } | undefined> {
  const records = await store.list();
  const candidates = records.filter((r) => r.slotName === slotName);
  const winner = resolveHookWinner(candidates, url, labelFor);
  return winner ? { moduleId: winner.ownerModuleId } : undefined;
}
