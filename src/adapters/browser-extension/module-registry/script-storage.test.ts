import { beforeEach, describe, expect, it } from 'vitest';
import {
  type ScriptStorageBackend,
  clearScriptStorage,
  clearSessionScopedStorageForTab,
  clearTabScopedStorageForTab,
  createScriptStorage,
  namespacePrefixFor,
} from './script-storage';

/**
 * docs/ROADMAP.md §11.3 constraint A — the precondition of the whole permission model. The store
 * these keys live in also holds the grant records, so "a script can write any key" and "a script
 * can grant itself anything" were the same sentence before this existed.
 */
function fakeBackend(initial: Record<string, unknown> = {}): ScriptStorageBackend & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (k in data) out[k] = data[k];
      return out;
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(keys) {
      for (const k of keys) delete data[k];
    },
    async listKeys() {
      return Object.keys(data);
    },
  };
}

/** The extension's own records, as they really sit in chrome.storage.local. */
const EXTENSION_KEYS = {
  'synapse:grants': { 'some-script': { scopes: [], sourceHash: 'abc' } },
  'synapse:uploaded': { 'some-script': 'console.log(1)' },
  'synapse:activation': { 'network-sniffer': true },
};

describe('script storage — namespacing (permanent/root)', () => {
  let backend: ReturnType<typeof fakeBackend>;

  beforeEach(() => {
    backend = fakeBackend(EXTENSION_KEYS);
  });

  it('stores under script:<moduleId>:<userKey>, never at the raw key', async () => {
    const storage = createScriptStorage('script-a', undefined, backend);
    await storage.set('token', 'v1');

    expect(backend.data['script:script-a:token']).toBe('v1');
    expect(backend.data['token']).toBeUndefined();
    await expect(storage.get('token')).resolves.toBe('v1');
  });

  it('CANNOT read or write the extension’s own records — the escalation the old `cache` service allowed', async () => {
    const storage = createScriptStorage('evil-script', undefined, backend);

    await storage.set('synapse:grants', { 'evil-script': ['everything'] });

    // The real grants record is untouched; the write landed inside the script's own namespace.
    expect(backend.data['synapse:grants']).toEqual(EXTENSION_KEYS['synapse:grants']);
    expect(backend.data['script:evil-script:synapse:grants']).toEqual({ 'evil-script': ['everything'] });

    await expect(storage.get('synapse:grants')).resolves.toEqual({ 'evil-script': ['everything'] });
    await expect(storage.get('synapse:uploaded')).resolves.toBeUndefined();
    await expect(storage.get('synapse:activation')).resolves.toBeUndefined();
  });

  it('cannot reach another script’s data, however the key is crafted', async () => {
    const a = createScriptStorage('script-a', undefined, backend);
    const b = createScriptStorage('script-b', undefined, backend);

    await a.set('secret', 'a-value');

    await expect(b.get('secret')).resolves.toBeUndefined();
    // No traversal: the prefix is prepended, so this just nests deeper inside b's own namespace.
    await expect(b.get('../script-a:secret')).resolves.toBeUndefined();
    await expect(b.keys()).resolves.toEqual([]);
    await b.set('secret', 'b-value');
    await expect(a.get('secret')).resolves.toBe('a-value');
  });

  it('rejects a moduleId containing ":" — otherwise {a, "b:c"} and {"a:b", c} would collide', () => {
    expect(() => namespacePrefixFor('a:b')).toThrow(/must not contain/);
    expect(() => namespacePrefixFor('')).toThrow(/required/);
  });

  it('rejects a non-string key loudly instead of coercing it', async () => {
    const storage = createScriptStorage('script-a', undefined, backend);
    await expect(storage.get(undefined as unknown as string)).rejects.toThrow(/non-empty string/);
    await expect(storage.set(42 as unknown as string, 1)).rejects.toThrow(/non-empty string/);
    await expect(storage.remove('' as string)).rejects.toThrow(/non-empty string/);
  });

  it('keys() lists only this script’s keys, with the prefix stripped', async () => {
    const a = createScriptStorage('script-a', undefined, backend);
    await a.set('one', 1);
    await a.set('two', 2);
    await createScriptStorage('script-b', undefined, backend).set('three', 3);

    await expect(a.keys()).resolves.toEqual(['one', 'two']);
  });

  it('remove() deletes only the namespaced key', async () => {
    const storage = createScriptStorage('script-a', undefined, backend);
    await storage.set('one', 1);
    await storage.remove('one');

    expect(backend.data['script:script-a:one']).toBeUndefined();
    expect(backend.data['synapse:grants']).toBeDefined();
  });

  it('clearScriptStorage drops one script’s keys and nothing else', async () => {
    await createScriptStorage('script-a', undefined, backend).set('one', 1);
    await createScriptStorage('script-b', undefined, backend).set('two', 2);

    await clearScriptStorage('script-a', backend);

    expect(backend.data['script:script-a:one']).toBeUndefined();
    expect(backend.data['script:script-b:two']).toBe(2);
    expect(backend.data['synapse:uploaded']).toBeDefined();
  });
});

/** docs/ROADMAP.md Track A2 — `storage.tab`/`storage.session`, same namespacing rigor as the root
 * store above, plus the two lifetime axes: which tab a key belongs to, and which sweep clears it. */
describe('script storage — tab/session lifetime', () => {
  let backend: ReturnType<typeof fakeBackend>;

  beforeEach(() => {
    backend = fakeBackend();
  });

  it('storage.tab is namespaced per script AND per tab', async () => {
    const aTab1 = createScriptStorage('script-a', 1, backend);
    const aTab2 = createScriptStorage('script-a', 2, backend);
    const bTab1 = createScriptStorage('script-b', 1, backend);

    await aTab1.tab.set('key', 'a-tab1');
    await aTab2.tab.set('key', 'a-tab2');
    await bTab1.tab.set('key', 'b-tab1');

    await expect(aTab1.tab.get('key')).resolves.toBe('a-tab1');
    await expect(aTab2.tab.get('key')).resolves.toBe('a-tab2');
    await expect(bTab1.tab.get('key')).resolves.toBe('b-tab1');
  });

  it('storage.tab and storage.session are independent namespaces, even for the same script+tab+key', async () => {
    const storage = createScriptStorage('script-a', 1, backend);
    await storage.tab.set('key', 'tab-value');
    await storage.session.set('key', 'session-value');

    await expect(storage.tab.get('key')).resolves.toBe('tab-value');
    await expect(storage.session.get('key')).resolves.toBe('session-value');
  });

  it('a script writing an ordinary storage.set() key is never visible through storage.tab/session, and vice versa', async () => {
    const storage = createScriptStorage('script-a', 1, backend);
    await storage.set('key', 'permanent-value');
    await storage.tab.set('key', 'tab-value');

    await expect(storage.get('key')).resolves.toBe('permanent-value');
    await expect(storage.tab.get('key')).resolves.toBe('tab-value');
    await expect(storage.keys()).resolves.toEqual(['key']); // root keys() doesn't leak the tab-scoped one
  });

  it('storage.tab/storage.session reject with no tab context (background Module transport)', async () => {
    const storage = createScriptStorage('script-a', undefined, backend);
    await expect(storage.tab.get('key')).rejects.toThrow(/only available to code attached to a real tab/);
    await expect(storage.session.set('key', 1)).rejects.toThrow(/only available to code attached to a real tab/);
  });

  it('clearTabScopedStorageForTab evicts every script’s storage.tab keys for that tab, and no others', async () => {
    await createScriptStorage('script-a', 1, backend).tab.set('key', 'a1');
    await createScriptStorage('script-a', 2, backend).tab.set('key', 'a2');
    await createScriptStorage('script-b', 1, backend).tab.set('key', 'b1');
    await createScriptStorage('script-a', 1, backend).session.set('key', 'session-a1'); // must survive
    await createScriptStorage('script-a', 1, backend).set('key', 'permanent-a1'); // must survive

    await clearTabScopedStorageForTab(1, backend);

    await expect(createScriptStorage('script-a', 1, backend).tab.get('key')).resolves.toBeUndefined();
    await expect(createScriptStorage('script-b', 1, backend).tab.get('key')).resolves.toBeUndefined();
    await expect(createScriptStorage('script-a', 2, backend).tab.get('key')).resolves.toBe('a2');
    await expect(createScriptStorage('script-a', 1, backend).session.get('key')).resolves.toBe('session-a1');
    await expect(createScriptStorage('script-a', 1, backend).get('key')).resolves.toBe('permanent-a1');
  });

  it('clearTabScopedStorageForTab does not confuse tab 1 with tab 10 (colon-delimited, not substring)', async () => {
    await createScriptStorage('script-a', 1, backend).tab.set('key', 'tab1');
    await createScriptStorage('script-a', 10, backend).tab.set('key', 'tab10');

    await clearTabScopedStorageForTab(1, backend);

    await expect(createScriptStorage('script-a', 1, backend).tab.get('key')).resolves.toBeUndefined();
    await expect(createScriptStorage('script-a', 10, backend).tab.get('key')).resolves.toBe('tab10');
  });

  it('clearSessionScopedStorageForTab evicts every script’s storage.session keys for that tab, leaving storage.tab untouched', async () => {
    await createScriptStorage('script-a', 1, backend).session.set('key', 'session-a1');
    await createScriptStorage('script-b', 1, backend).session.set('key', 'session-b1');
    await createScriptStorage('script-a', 1, backend).tab.set('key', 'tab-a1'); // must survive

    await clearSessionScopedStorageForTab(1, backend);

    await expect(createScriptStorage('script-a', 1, backend).session.get('key')).resolves.toBeUndefined();
    await expect(createScriptStorage('script-b', 1, backend).session.get('key')).resolves.toBeUndefined();
    await expect(createScriptStorage('script-a', 1, backend).tab.get('key')).resolves.toBe('tab-a1');
  });

  it('clearScriptStorage also drops that script’s tab/session keys across every tab', async () => {
    await createScriptStorage('script-a', 1, backend).tab.set('key', 'a1');
    await createScriptStorage('script-a', 2, backend).session.set('key', 'a2');
    await createScriptStorage('script-a', undefined, backend).set('key', 'permanent');
    await createScriptStorage('script-b', 1, backend).tab.set('key', 'b1'); // must survive

    await clearScriptStorage('script-a', backend);

    await expect(createScriptStorage('script-a', 1, backend).tab.get('key')).resolves.toBeUndefined();
    await expect(createScriptStorage('script-a', 2, backend).session.get('key')).resolves.toBeUndefined();
    await expect(createScriptStorage('script-a', undefined, backend).get('key')).resolves.toBeUndefined();
    await expect(createScriptStorage('script-b', 1, backend).tab.get('key')).resolves.toBe('b1');
  });
});
