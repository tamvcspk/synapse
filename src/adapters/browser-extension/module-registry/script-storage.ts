import type { SynapseStorageApi } from '../../../kernel/synapse-api';

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

export function namespacePrefixFor(moduleId: string): string {
  if (typeof moduleId !== 'string' || moduleId.length === 0) {
    throw new Error('script storage: moduleId is required');
  }
  if (moduleId.includes(':')) {
    throw new Error(`script storage: moduleId must not contain ":" (got "${moduleId}")`);
  }
  return `${KEY_PREFIX}${moduleId}:`;
}

function assertUserKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('script storage: key must be a non-empty string');
  }
}

export function createScriptStorage(
  moduleId: string,
  backend: ScriptStorageBackend = chromeStorageBackend,
): SynapseStorageApi {
  const prefix = namespacePrefixFor(moduleId);

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

/** Drops everything a script stored — for when its module is removed. Scoped by the same prefix,
 * so it can only ever delete that script's own keys. */
export async function clearScriptStorage(
  moduleId: string,
  backend: ScriptStorageBackend = chromeStorageBackend,
): Promise<void> {
  const prefix = namespacePrefixFor(moduleId);
  const all = await backend.listKeys();
  const owned = all.filter((k) => k.startsWith(prefix));
  if (owned.length > 0) await backend.remove(owned);
}
