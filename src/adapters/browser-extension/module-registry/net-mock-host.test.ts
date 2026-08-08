import { describe, expect, it, vi } from 'vitest';
import type { MockConfig } from '../../../shared/http-mock';
import { performMockAdd, performMockList, performMockRemove, type MockRuleStore } from './net-mock-host';

/**
 * `getMockConfigs`/`setMockConfigs`/`syncRegistration` are never touched here — a `MockRuleStore`
 * fake stands in (same DI pattern `files-save-host.test.ts` uses for `DownloadsBackend`), so these
 * tests pin what this file itself does: building a valid MockConfig, ownership filtering, and
 * calling save/sync in the right order. Real chrome.storage/scripting/debugger wiring is out of
 * scope for a unit test.
 *
 * `http-error-mocker.background.ts` is mocked at the module level — `net-mock-host.ts` imports
 * `syncRegistration` from it statically (see that import's own doc comment for why NOT a dynamic
 * `import()`), and that file transitively pulls in `utils/dnr-network-rules.ts`, whose top-level
 * `chrome.declarativeNetRequest.ResourceType` read throws `chrome is not defined` the moment the
 * module is evaluated in a chrome-less `environment: 'node'` test — before any test body runs, and
 * regardless of whether `sync()` is ever actually called (every test here uses its own `MockRuleStore`
 * fake, which never touches the real one). `vi.mock` is hoisted above imports by vitest, so the real
 * module is never evaluated at all.
 */
vi.mock('../features/http-mock/http-error-mocker.background', () => ({ syncRegistration: vi.fn() }));
function fakeStore(initial: MockConfig[] = []): MockRuleStore & { configs: MockConfig[]; syncCalls: number } {
  const state = { configs: [...initial], syncCalls: 0 };
  return {
    configs: state.configs,
    get syncCalls() {
      return state.syncCalls;
    },
    list: async () => state.configs,
    save: async (configs: MockConfig[]) => {
      state.configs = configs;
    },
    sync: async () => {
      state.syncCalls += 1;
    },
  } as unknown as MockRuleStore & { configs: MockConfig[]; syncCalls: number };
}

describe('performMockAdd', () => {
  it('rejects a missing/empty endpointPattern before touching the store', async () => {
    const store = fakeStore();
    const saveSpy = vi.spyOn(store, 'save');

    await expect(performMockAdd('script-a', { endpointPattern: '' }, store)).rejects.toThrow(/"endpointPattern" is required/);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('builds a main-world fake-response rule, owned by the calling module, with sane defaults', async () => {
    const store = fakeStore();

    const { id } = await performMockAdd('script-a', { endpointPattern: 'https://api.example.com/*' }, store);

    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        id,
        endpointPattern: 'https://api.example.com/*',
        method: 'ALL',
        mechanism: 'main-world',
        action: 'fake-response',
        fakeStatus: 200,
        active: true,
        ownerModuleId: 'script-a',
      }),
    ]);
  });

  it('passes through method/fakeStatus/fakeResponse/delayMs when given', async () => {
    const store = fakeStore();

    await performMockAdd(
      'script-a',
      { endpointPattern: 'https://api.example.com/*', method: 'POST', fakeStatus: 503, fakeResponse: { ok: false }, delayMs: 250 },
      store,
    );

    const [config] = await store.list();
    expect(config).toMatchObject({ method: 'POST', fakeStatus: 503, fakeResponse: { ok: false }, delayMs: 250 });
  });

  it('rejects (via the shared validator) a fakeStatus out of range, without calling save', async () => {
    const store = fakeStore();
    const saveSpy = vi.spyOn(store, 'save');

    await expect(performMockAdd('script-a', { endpointPattern: 'https://api.example.com/*', fakeStatus: 999 }, store)).rejects.toThrow(
      /fakeStatus/,
    );
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('docs/ROADMAP.md Track B2b: action "block" resolves to mechanism "dnr" — no debugger banner needed', async () => {
    const store = fakeStore();

    await performMockAdd('script-a', { endpointPattern: 'https://api.example.com/*', action: 'block' }, store);

    const [config] = await store.list();
    expect(config).toMatchObject({ action: 'block', mechanism: 'dnr' });
    expect(config).not.toHaveProperty('fakeStatus');
  });

  it('action "rewrite-request" with a body resolves to mechanism "main-world"', async () => {
    const store = fakeStore();

    await performMockAdd(
      'script-a',
      { endpointPattern: 'https://api.example.com/*', action: 'rewrite-request', rewriteUrl: 'https://api.example.com/v2', rewriteBody: 'new body' },
      store,
    );

    const [config] = await store.list();
    expect(config).toMatchObject({ action: 'rewrite-request', mechanism: 'main-world', rewriteUrl: 'https://api.example.com/v2', rewriteBody: 'new body' });
  });

  it('action "rewrite-request" with a body AND matchAnyResourceType resolves to mechanism "debugger" — the one grant-gated combo', async () => {
    const store = fakeStore();

    await performMockAdd(
      'script-a',
      { endpointPattern: 'https://api.example.com/*', action: 'rewrite-request', rewriteBody: 'new body', matchAnyResourceType: true },
      store,
    );

    const [config] = await store.list();
    expect(config).toMatchObject({ mechanism: 'debugger' });
  });

  it('serializes rewriteHeaders (a plain object over the wire) into the JSON-text form MockConfig stores', async () => {
    const store = fakeStore();

    await performMockAdd(
      'script-a',
      { endpointPattern: 'https://api.example.com/*', action: 'rewrite-request', rewriteHeaders: { 'X-Foo': 'bar' } },
      store,
    );

    const [config] = await store.list();
    expect(config).toMatchObject({ rewriteHeaders: JSON.stringify({ 'X-Foo': 'bar' }) });
  });

  it('appends to existing rules rather than replacing them, and resyncs interception once', async () => {
    const existing: MockConfig = {
      id: 'existing',
      endpointPattern: 'https://other.example.com/*',
      method: 'ALL',
      mechanism: 'main-world',
      action: 'fake-response',
      fakeStatus: 200,
      active: true,
    };
    const store = fakeStore([existing]);

    await performMockAdd('script-a', { endpointPattern: 'https://api.example.com/*' }, store);

    const configs = await store.list();
    expect(configs).toHaveLength(2);
    expect(configs[0]).toBe(existing);
    expect(store.syncCalls).toBe(1);
  });
});

describe('performMockRemove', () => {
  function ownedConfig(id: string, ownerModuleId: string): MockConfig {
    return {
      id,
      endpointPattern: 'https://api.example.com/*',
      method: 'ALL',
      mechanism: 'main-world',
      action: 'fake-response',
      fakeStatus: 200,
      active: true,
      ownerModuleId,
    };
  }

  it('rejects a missing/empty id', async () => {
    const store = fakeStore();
    await expect(performMockRemove('script-a', '', store)).rejects.toThrow(/"id" is required/);
  });

  it("refuses to remove a rule owned by a different script, with the same message as a nonexistent id", async () => {
    const store = fakeStore([ownedConfig('r1', 'script-b')]);

    await expect(performMockRemove('script-a', 'r1', store)).rejects.toThrow(/no rule "r1" owned by this script/);
    await expect(performMockRemove('script-a', 'does-not-exist', store)).rejects.toThrow(/no rule "does-not-exist" owned by this script/);
    expect(await store.list()).toHaveLength(1); // untouched
  });

  it('refuses to remove a hand-authored rule (no ownerModuleId at all)', async () => {
    const handAuthored: MockConfig = {
      id: 'r1',
      endpointPattern: 'https://api.example.com/*',
      method: 'ALL',
      mechanism: 'debugger',
      action: 'fake-response',
      fakeStatus: 200,
      active: true,
    };
    const store = fakeStore([handAuthored]);

    await expect(performMockRemove('script-a', 'r1', store)).rejects.toThrow(/no rule "r1" owned by this script/);
  });

  it("removes its own rule and resyncs interception", async () => {
    const store = fakeStore([ownedConfig('r1', 'script-a'), ownedConfig('r2', 'script-a')]);

    await performMockRemove('script-a', 'r1', store);

    const configs = await store.list();
    expect(configs.map((c) => c.id)).toEqual(['r2']);
    expect(store.syncCalls).toBe(1);
  });
});

describe('performMockList', () => {
  it("returns only the calling script's own rules, projected to the public shape", async () => {
    const mine: MockConfig = {
      id: 'r1',
      endpointPattern: 'https://api.example.com/*',
      method: 'POST',
      mechanism: 'main-world',
      action: 'fake-response',
      fakeStatus: 503,
      fakeResponse: { ok: false },
      delayMs: 100,
      active: true,
      ownerModuleId: 'script-a',
    };
    const someoneElses: MockConfig = { ...mine, id: 'r2', ownerModuleId: 'script-b' };
    const { ownerModuleId: _omit, ...withoutOwner } = mine;
    const handAuthored: MockConfig = { ...withoutOwner, id: 'r3' };
    const store = fakeStore([mine, someoneElses, handAuthored]);

    const result = await performMockList('script-a', store);

    expect(result).toEqual([
      { id: 'r1', endpointPattern: 'https://api.example.com/*', method: 'POST', action: 'fake-response', fakeStatus: 503, fakeResponse: { ok: false }, delayMs: 100 },
    ]);
  });

  it('projects a rewrite-request rule with its rewrite fields, parsing rewriteHeaders back into an object', async () => {
    const rewrite: MockConfig = {
      id: 'r1',
      endpointPattern: 'https://api.example.com/*',
      method: 'ALL',
      mechanism: 'main-world',
      action: 'rewrite-request',
      rewriteUrl: 'https://api.example.com/v2',
      rewriteHeaders: JSON.stringify({ 'X-Foo': 'bar' }),
      rewriteBody: 'new body',
      active: true,
      ownerModuleId: 'script-a',
    };
    const store = fakeStore([rewrite]);

    const result = await performMockList('script-a', store);

    expect(result).toEqual([
      {
        id: 'r1',
        endpointPattern: 'https://api.example.com/*',
        method: 'ALL',
        action: 'rewrite-request',
        rewriteUrl: 'https://api.example.com/v2',
        rewriteHeaders: { 'X-Foo': 'bar' },
        rewriteBody: 'new body',
      },
    ]);
  });

  it('projects a block rule with no extra fields at all', async () => {
    const block: MockConfig = {
      id: 'r1',
      endpointPattern: 'https://api.example.com/*',
      method: 'ALL',
      mechanism: 'dnr',
      action: 'block',
      active: true,
      ownerModuleId: 'script-a',
    };
    const store = fakeStore([block]);

    const result = await performMockList('script-a', store);

    expect(result).toEqual([{ id: 'r1', endpointPattern: 'https://api.example.com/*', method: 'ALL', action: 'block' }]);
  });

  it('returns an empty list, not an error, when the script has no rules', async () => {
    const store = fakeStore();
    await expect(performMockList('script-a', store)).resolves.toEqual([]);
  });
});
