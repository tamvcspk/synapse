import { DEFAULT_MECHANISM, validateMockConfig, type MockConfig } from '../../../shared/http-mock';
import type { SynapseMockRule, SynapseMockRuleOptions } from '../../../kernel/synapse-api';
import { chromeStorageCache } from '../background/services/cache';
import { syncRegistration } from '../features/http-mock/http-error-mocker.background';
import { getMockConfigs, setMockConfigs } from '../features/http-mock/mock-config-store.background';

/**
 * Backs `synapseApi.mock.*` (docs/api-inventory.md §3.2 — "the cheapest domain API"). Reuses the
 * SAME `MockConfig` collection and interception plumbing the "HTTP Mock & Rewrite" Management View
 * panel owns (`mock-config-store.background.ts`/`http-error-mocker.background.ts`) rather than
 * standing up a second content-script + storage key — the main-world payload already applies every
 * ACTIVE config in that one collection regardless of who wrote it, so a script's rule is real the
 * moment it's saved, no new delivery mechanism needed.
 *
 * Deliberately narrow for v1, matching `SynapseNetMockApi`'s own doc comment:
 * - Only `action: 'fake-response'`, `mechanism: 'main-world'` — the platform picks the mechanism,
 *   never the script (docs/api-inventory.md §3.2's "mechanism do platform chọn, không do script
 *   khai"); `main-world` is the cheapest (no `debugger` banner, no DNR rule budget) and the only
 *   one every `fake-response` config already supports unconditionally.
 * - `ownerModuleId` (shared/http-mock.ts) is what isolates one script's rules from another's AND
 *   from the user's own hand-authored ones — `.remove()`/`.list()` filter by it, never by `id`
 *   alone. The resource-dimension (`match`) check that gates WHICH origins a script may add a rule
 *   for happens one layer up, in `rpc-handler.ts` (`net.mock`'s `resourceUrl` extractor), before
 *   `performMockAdd` is ever called — this file only enforces ownership, not origin.
 */

export interface MockRuleStore {
  list(): Promise<MockConfig[]>;
  save(configs: MockConfig[]): Promise<void>;
  /** Re-registers whichever interception mechanisms the current config list needs — the same
   * resync the Management View's own CRUD path triggers after every upsert/delete. */
  sync(): Promise<void>;
}

/** Injected (default: the real chrome.storage-backed collection) so add/remove/list are
 * unit-testable in `environment: 'node'` without chrome.scripting/debugger/declarativeNetRequest —
 * same DI pattern `files-save-host.ts`'s `DownloadsBackend` uses for the same reason.
 *
 * `syncRegistration` is a plain top-level `import`, deliberately NOT a dynamic `import()` — a
 * dynamic import here once seemed like the fix for `http-error-mocker.background.ts` pulling in
 * `utils/dnr-network-rules.ts`'s top-level `chrome.declarativeNetRequest.ResourceType` read (which
 * throws in a chrome-less unit test), but it was wrong: Vite wraps EVERY dynamic `import()` with its
 * `__vitePreload` helper, which injects a `<link>` via `document.head.appendChild` — fine in a page,
 * fatal in a service worker, which has no `document` at all. That shipped as a real "document is not
 * defined" failure on `mock.add`'s first real call. It also bought nothing: this exact module is
 * ALREADY loaded eagerly in production, as one of the bundled Modules in the builtin registry — a dynamic
 * import here never deferred anything real, it only deferred the throw from build time to first
 * call. `net-mock-host.test.ts` instead `vi.mock()`s this specifier, which is the actual right tool
 * for "don't evaluate this module's transitive chrome.* dependency in a unit test". */
const realStore: MockRuleStore = {
  list: () => getMockConfigs(),
  save: (configs) => setMockConfigs(configs),
  sync: () => syncRegistration(chromeStorageCache),
};

function toSynapseMockRule(config: MockConfig): SynapseMockRule {
  const rule: SynapseMockRule = {
    id: config.id,
    endpointPattern: config.endpointPattern,
    method: config.method,
    fakeStatus: config.fakeStatus ?? 200,
  };
  if (config.fakeResponse !== undefined) rule.fakeResponse = config.fakeResponse;
  if (config.delayMs !== undefined) rule.delayMs = config.delayMs;
  return rule;
}

export async function performMockAdd(
  moduleId: string,
  options: SynapseMockRuleOptions,
  store: MockRuleStore = realStore,
): Promise<{ id: string }> {
  if (typeof options?.endpointPattern !== 'string' || options.endpointPattern === '') {
    throw new Error('mock.add: "endpointPattern" is required');
  }

  // mechanism/action are fixed, never taken from options — see this file's own header comment on
  // why the platform picks them. Built as Record<string,unknown> rather than a literal so an absent
  // fakeResponse/delayMs is OMITTED, not set to `undefined` (this project's exactOptionalPropertyTypes
  // convention, same as net-request-host.ts's requestInit).
  const candidate: Record<string, unknown> = {
    id: crypto.randomUUID(),
    endpointPattern: options.endpointPattern,
    method: options.method ?? 'ALL',
    mechanism: DEFAULT_MECHANISM,
    action: 'fake-response',
    fakeStatus: options.fakeStatus ?? 200,
    active: true,
    ownerModuleId: moduleId,
  };
  if (options.fakeResponse !== undefined) candidate.fakeResponse = options.fakeResponse;
  if (options.delayMs !== undefined) candidate.delayMs = options.delayMs;

  // Reuses the SAME validator the Management View's form submits through — fakeStatus range,
  // method enum, etc. all get checked here for free, never re-implemented.
  const result = validateMockConfig(candidate);
  if (!result.valid) throw new Error(`mock.add: ${result.reason}`);

  const configs = await store.list();
  configs.push(result.config);
  await store.save(configs);
  await store.sync();
  return { id: result.config.id };
}

export async function performMockRemove(moduleId: string, id: unknown, store: MockRuleStore = realStore): Promise<void> {
  if (typeof id !== 'string' || id === '') {
    throw new Error('mock.remove: "id" is required');
  }

  const configs = await store.list();
  const target = configs.find((c) => c.id === id);
  // Same message whether the id doesn't exist at all or belongs to someone else — distinguishing
  // them would let a script probe for other scripts' (or the user's own) rule ids by id-guessing.
  if (!target || target.ownerModuleId !== moduleId) {
    throw new Error(`mock.remove: no rule "${id}" owned by this script`);
  }

  await store.save(configs.filter((c) => c.id !== id));
  await store.sync();
}

export async function performMockList(moduleId: string, store: MockRuleStore = realStore): Promise<SynapseMockRule[]> {
  const configs = await store.list();
  return configs.filter((c) => c.ownerModuleId === moduleId).map(toSynapseMockRule);
}
