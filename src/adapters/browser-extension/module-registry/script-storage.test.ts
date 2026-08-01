import { beforeEach, describe, expect, it } from 'vitest';
import {
  type ScriptStorageBackend,
  clearScriptStorage,
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

describe('script storage — namespacing', () => {
  let backend: ReturnType<typeof fakeBackend>;

  beforeEach(() => {
    backend = fakeBackend(EXTENSION_KEYS);
  });

  it('stores under script:<moduleId>:<userKey>, never at the raw key', async () => {
    const storage = createScriptStorage('script-a', backend);
    await storage.set('token', 'v1');

    expect(backend.data['script:script-a:token']).toBe('v1');
    expect(backend.data['token']).toBeUndefined();
    await expect(storage.get('token')).resolves.toBe('v1');
  });

  it('CANNOT read or write the extension’s own records — the escalation the old `cache` service allowed', async () => {
    const storage = createScriptStorage('evil-script', backend);

    await storage.set('synapse:grants', { 'evil-script': ['everything'] });

    // The real grants record is untouched; the write landed inside the script's own namespace.
    expect(backend.data['synapse:grants']).toEqual(EXTENSION_KEYS['synapse:grants']);
    expect(backend.data['script:evil-script:synapse:grants']).toEqual({ 'evil-script': ['everything'] });

    await expect(storage.get('synapse:grants')).resolves.toEqual({ 'evil-script': ['everything'] });
    await expect(storage.get('synapse:uploaded')).resolves.toBeUndefined();
    await expect(storage.get('synapse:activation')).resolves.toBeUndefined();
  });

  it('cannot reach another script’s data, however the key is crafted', async () => {
    const a = createScriptStorage('script-a', backend);
    const b = createScriptStorage('script-b', backend);

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
    const storage = createScriptStorage('script-a', backend);
    await expect(storage.get(undefined as unknown as string)).rejects.toThrow(/non-empty string/);
    await expect(storage.set(42 as unknown as string, 1)).rejects.toThrow(/non-empty string/);
    await expect(storage.remove('' as string)).rejects.toThrow(/non-empty string/);
  });

  it('keys() lists only this script’s keys, with the prefix stripped', async () => {
    const a = createScriptStorage('script-a', backend);
    await a.set('one', 1);
    await a.set('two', 2);
    await createScriptStorage('script-b', backend).set('three', 3);

    await expect(a.keys()).resolves.toEqual(['one', 'two']);
  });

  it('remove() deletes only the namespaced key', async () => {
    const storage = createScriptStorage('script-a', backend);
    await storage.set('one', 1);
    await storage.remove('one');

    expect(backend.data['script:script-a:one']).toBeUndefined();
    expect(backend.data['synapse:grants']).toBeDefined();
  });

  it('clearScriptStorage drops one script’s keys and nothing else', async () => {
    await createScriptStorage('script-a', backend).set('one', 1);
    await createScriptStorage('script-b', backend).set('two', 2);

    await clearScriptStorage('script-a', backend);

    expect(backend.data['script:script-a:one']).toBeUndefined();
    expect(backend.data['script:script-b:two']).toBe(2);
    expect(backend.data['synapse:uploaded']).toBeDefined();
  });
});
