import type { SynapseKeyValueApi, SynapseStorageApi } from '../../../kernel/synapse-api';

/**
 * The `storage.rw` scope's implementation — a key/value store namespaced per script
 * (docs/ROADMAP.md §11.3 constraint A).
 *
 * This is the precondition of the entire permission model, not a nicety. The store it sits on
 * (`chrome.storage.local`) is also where the extension keeps the grant records themselves, so the
 * previous unnamespaced `cache` service was a privilege-escalation primitive: any script granted
 * `cache` could write `synapse:grants` and hand itself every capability, read `synapse:uploaded` to
 * dump every other script's source, or flip `synapse:activation`. That hole closes here and in
 * `rpc-handler.ts`, which no longer routes a raw key/value service at all.
 *
 * The namespace is applied by *prepending*, and `moduleId` comes from the transport rather than
 * from any argument — so no caller-supplied key can escape it. A key containing `:` merely lands
 * deeper inside the script's own namespace. (`moduleId` itself is rejected if it contains `:`,
 * which is what stops `{module:"a", key:"b:c"}` and `{module:"a:b", key:"c"}` from colliding.)
 *
 * Deliberately NOT a single nested blob under one storage key: two scripts writing concurrently
 * would then read-modify-write over each other, and a service worker gives no way to hold a lock
 * across that. Flat prefixed keys let `chrome.storage.local` arbitrate per key, as it already does.
 */

const KEY_PREFIX = 'script:';
/** docs/ROADMAP.md Track A2 — `storage.tab`/`storage.session` get their OWN top-level prefixes,
 * deliberately NOT nested under `KEY_PREFIX` (`script:<moduleId>:tab:...`): the root namespace's
 * user-supplied keys are free-form strings a script could craft to start with `tab:`/`session:`,
 * and nesting would make that collide with the reserved sub-namespace. A sibling prefix can never
 * collide with `KEY_PREFIX` (`"script-tab:".startsWith("script:")` is false), so no such crafted
 * key can ever land here. */
const TAB_PREFIX = 'script-tab:';
const SESSION_PREFIX = 'script-session:';

/** The subset of `chrome.storage.local` this needs, injectable so the namespacing rules can be
 * tested in `environment: 'node'` without a browser (docs/ROADMAP.md §11.2's note on what is and
 * isn't testable here). */
export interface ScriptStorageBackend {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
  listKeys(): Promise<string[]>;
}

export const chromeStorageBackend: ScriptStorageBackend = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys),
  listKeys: async () => Object.keys(await chrome.storage.local.get(null)),
};

function assertModuleId(moduleId: string): void {
  if (typeof moduleId !== 'string' || moduleId.length === 0) {
    throw new Error('script storage: moduleId is required');
  }
  if (moduleId.includes(':')) {
    throw new Error(`script storage: moduleId must not contain ":" (got "${moduleId}")`);
  }
}

export function namespacePrefixFor(moduleId: string): string {
  assertModuleId(moduleId);
  return `${KEY_PREFIX}${moduleId}:`;
}

/** `tabId` rides in its own colon-delimited segment (never string-concatenated with `moduleId`),
 * so a sweep across every module's tab storage (`clearTabScopedStorageForTab`) can pull it back out
 * unambiguously — seeing `"...5:"` in the key never matches `tabId=50` or vice versa. */
function tabPrefixFor(moduleId: string, tabId: number): string {
  assertModuleId(moduleId);
  return `${TAB_PREFIX}${moduleId}:${tabId}:`;
}

function sessionPrefixFor(moduleId: string, tabId: number): string {
  assertModuleId(moduleId);
  return `${SESSION_PREFIX}${moduleId}:${tabId}:`;
}

function assertUserKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('script storage: key must be a non-empty string');
  }
}

/** Plain get/set/remove/keys over one fixed prefix — the one implementation shared by the root
 * (permanent) namespace and both lifetime-scoped sub-namespaces below; they differ only in which
 * prefix they're built with and when the platform sweeps their keys away, never in this logic. */
function createKeyValueApi(prefix: string, backend: ScriptStorageBackend): SynapseKeyValueApi {
  return {
    async get(key) {
      assertUserKey(key);
      const stored = await backend.get([prefix + key]);
      return stored[prefix + key];
    },
    async set(key, value) {
      assertUserKey(key);
      await backend.set({ [prefix + key]: value });
    },
    async remove(key) {
      assertUserKey(key);
      await backend.remove([prefix + key]);
    },
    async keys() {
      const all = await backend.listKeys();
      return all.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    },
  };
}

/** `storage.tab`/`storage.session` for a caller with no tab of its own (a background Module) —
 * same "throw with a real explanation" posture as `synapse-api-host.ts`'s `backgroundPageStub`,
 * not a silent no-op: reaching for a tab-scoped store from code that isn't attached to any tab is a
 * real design error in the calling script, not a platform limitation to route around quietly. */
function unavailableKeyValueApi(namespaceLabel: 'tab' | 'session'): SynapseKeyValueApi {
  const unavailable = (): Promise<never> =>
    Promise.reject(
      new Error(
        `synapseApi.storage.${namespaceLabel} is only available to code attached to a real tab (a ` +
          'dom Module or an uploaded script). This call has no tab of its own — a background Module ' +
          'runs in the service worker, which is not attached to any tab.',
      ),
    );
  return { get: unavailable, set: unavailable, remove: unavailable, keys: unavailable };
}

/**
 * docs/ROADMAP.md Track A2 — `tabId` comes from the transport (`rpc-handler.ts`'s `sender.tab.id`,
 * threaded through `synapse-api-host.ts`'s `SynapseApiContext`), never from a caller-supplied
 * argument, same "identity from the transport" rule `moduleId` itself already follows.
 */
export function createScriptStorage(
  moduleId: string,
  tabId: number | undefined,
  backend: ScriptStorageBackend = chromeStorageBackend,
): SynapseStorageApi {
  return {
    ...createKeyValueApi(namespacePrefixFor(moduleId), backend),
    tab: tabId !== undefined ? createKeyValueApi(tabPrefixFor(moduleId, tabId), backend) : unavailableKeyValueApi('tab'),
    session: tabId !== undefined ? createKeyValueApi(sessionPrefixFor(moduleId, tabId), backend) : unavailableKeyValueApi('session'),
  };
}

/** Drops everything a script stored — for when its module is removed. Scoped by the same prefix,
 * so it can only ever delete that script's own keys. Widened for Track A2: also sweeps this
 * script's `storage.tab`/`storage.session` keys across EVERY tab (the `TAB_PREFIX`/`SESSION_PREFIX`
 * segment after `moduleId` is a tabId, matched generically, not one specific tab) — a deleted
 * script must leave nothing behind, in any of its three lifetime namespaces. */
export async function clearScriptStorage(
  moduleId: string,
  backend: ScriptStorageBackend = chromeStorageBackend,
): Promise<void> {
  assertModuleId(moduleId);
  const rootPrefix = namespacePrefixFor(moduleId);
  const tabPrefix = `${TAB_PREFIX}${moduleId}:`;
  const sessionPrefix = `${SESSION_PREFIX}${moduleId}:`;
  const all = await backend.listKeys();
  const owned = all.filter((k) => k.startsWith(rootPrefix) || k.startsWith(tabPrefix) || k.startsWith(sessionPrefix));
  if (owned.length > 0) await backend.remove(owned);
}

/** Extracts the tabId segment from a `TAB_PREFIX`/`SESSION_PREFIX` key
 * (`<prefix><moduleId>:<tabId>:<userKey...>`) — colon-delimited, not a substring match, so tab 1
 * can never be confused with tab 10 or 100 the way a naive `key.includes(':1:')` could be. Returns
 * `undefined` for a key that doesn't have this shape at all (defensive; every key under these two
 * prefixes is written by `tabPrefixFor`/`sessionPrefixFor` above, so this should never happen in
 * practice). */
function tabIdSegmentOf(key: string, prefix: string): string | undefined {
  const rest = key.slice(prefix.length); // "<moduleId>:<tabId>:<userKey...>"
  const afterModule = rest.slice(rest.indexOf(':') + 1); // "<tabId>:<userKey...>"
  const secondColon = afterModule.indexOf(':');
  return secondColon === -1 ? undefined : afterModule.slice(0, secondColon);
}

async function clearScopedStorageForTab(prefix: string, tabId: number, backend: ScriptStorageBackend): Promise<void> {
  const all = await backend.listKeys();
  const tabIdStr = String(tabId);
  const owned = all.filter((k) => k.startsWith(prefix) && tabIdSegmentOf(k, prefix) === tabIdStr);
  if (owned.length > 0) await backend.remove(owned);
}

/** docs/ROADMAP.md Track A2 — evicts EVERY script's `storage.tab` keys for `tabId`, across every
 * moduleId (unlike `clearScriptStorage`, which is scoped to one script). Called on
 * `chrome.tabs.onRemoved` (`features/media/state-lifetime.background.ts`) — a tab that's gone
 * can't come back, so nothing here needs to survive it. */
export async function clearTabScopedStorageForTab(tabId: number, backend: ScriptStorageBackend = chromeStorageBackend): Promise<void> {
  await clearScopedStorageForTab(TAB_PREFIX, tabId, backend);
}

/** docs/ROADMAP.md Track A2 — evicts EVERY script's `storage.session` keys for `tabId`. Called from
 * TWO triggers in `features/media/state-lifetime.background.ts`: `chrome.webNavigation.onCommitted`
 * (the tab is still alive, just navigated — `storage.tab` must NOT be touched here) and
 * `chrome.tabs.onRemoved` (the tab is gone, alongside `clearTabScopedStorageForTab`). */
export async function clearSessionScopedStorageForTab(tabId: number, backend: ScriptStorageBackend = chromeStorageBackend): Promise<void> {
  await clearScopedStorageForTab(SESSION_PREFIX, tabId, backend);
}
