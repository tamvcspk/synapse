import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { API_METHODS } from '../../../kernel/scopes';
import { SUBSCRIPTION_PUSH_CHANNEL_ID } from '../../../shared/subscription-bridge';
import { buildShimSource } from './user-script-shim';

/**
 * docs/ROADMAP.md §11.9 opened Phase 2 with: "can the platform run more than ONE user script?"
 * Every registered script shares a single USER_SCRIPT world per page, so a top-level
 * `const __SYNAPSE_MODULE_ID__` lands in that world's shared global lexical environment and the
 * second script evaluated on a page dies with a redeclaration SyntaxError before its own code ever
 * runs. These tests pin the fix (one function scope per script).
 *
 * `node:vm` is used rather than `new Function` deliberately: a Function body gets its own scope, so
 * it CANNOT reproduce the collision — the whole bug is about top-level declarations in a shared
 * realm, which is what `vm.runInContext` (evaluating each source as a script in one context) models.
 * The first test below is the control that proves the harness can still see the failure.
 */
/**
 * Minimal `window`/`CustomEvent` stand-in — the USER_SCRIPT world has both for real (it shares the
 * page's DOM), but `node:vm`'s bare context has neither. Needed once `subscriptionSource()`
 * (docs/api-inventory.md §6 item 8) started calling `window.addEventListener` unconditionally at
 * shim-eval time, not just inside a function body the way `uiSource()`'s `document.*` calls are —
 * every existing test in this file would otherwise fail with `window is not defined` the moment
 * ANY shim source is evaluated, not just the ones that exercise `onProgress`.
 */
function fakeWindow(): { window: unknown; CustomEvent: unknown; dispatch: (type: string, detail: unknown) => void } {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const window = {
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(handler);
    },
    removeEventListener: (type: string, handler: (event: unknown) => void) => {
      listeners.get(type)?.delete(handler);
    },
    dispatchEvent: (event: { type: string }) => {
      for (const handler of listeners.get(event.type) ?? []) handler(event);
    },
  };
  class CustomEvent {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  }
  return {
    window,
    CustomEvent,
    dispatch: (type, detail) => {
      for (const handler of listeners.get(type) ?? []) handler({ type, detail });
    },
  };
}

function sharedRealm(sendMessage: (m: any) => unknown = () => Promise.resolve()): vm.Context {
  const { window, CustomEvent, dispatch } = fakeWindow();
  const ctx = vm.createContext({
    chrome: { runtime: { sendMessage, onMessage: { addListener: () => {} } } },
    crypto,
    console,
    window,
    CustomEvent,
  });
  (ctx as { __dispatchSubscriptionEvent?: (topic: string, data: unknown) => void }).__dispatchSubscriptionEvent = (topic, data) =>
    dispatch(SUBSCRIPTION_PUSH_CHANNEL_ID, { topic, data });
  return ctx;
}

function evaluateAll(sources: string[], context: vm.Context = sharedRealm()): vm.Context {
  for (const source of sources) vm.runInContext(source, context);
  return context;
}

const USER_SOURCE = `
globalThis.__synapseModule = {
  id: 'demo',
  scopes: ['storage.rw'],
  async run() { return 1; },
};
`;

describe('buildShimSource', () => {
  it('CONTROL: two unwrapped scripts sharing one realm really do collide on a top-level const', () => {
    const unwrapped = 'const __SYNAPSE_MODULE_ID__ = "x";';
    expect(() => evaluateAll([unwrapped, unwrapped])).toThrow(/already been declared/);
  });

  it('wraps everything in one IIFE so two scripts can coexist in the shared USER_SCRIPT world', () => {
    const first = buildShimSource('id-1', USER_SOURCE);
    const second = buildShimSource('id-2', USER_SOURCE);

    expect(() => evaluateAll([first, second])).not.toThrow();
  });

  it('keeps the user’s own top-level declarations out of the shared world too', () => {
    const withTopLevelConst = `const helper = 1; globalThis.__synapseModule = { id: 'x', async run() { return helper; } };`;

    expect(() =>
      evaluateAll([buildShimSource('a', withTopLevelConst), buildShimSource('b', withTopLevelConst)]),
    ).not.toThrow();
  });

  it('bakes in the extension-assigned id, not anything the script declares about itself', () => {
    const source = buildShimSource('assigned-uuid', `globalThis.__synapseModule = { id: 'i-say-im-network-sniffer' };`);
    expect(source).toContain('const __SYNAPSE_MODULE_ID__ = "assigned-uuid"');
  });

  it('passes the API as ctx.api and exposes no retired namespace', () => {
    const source = buildShimSource('id', '');
    expect(source).toContain('{ api: synapseApi }');
    expect(source).toContain("__synapseCall('storage', 'get'");
    // `bus` was a god-capability, `cache` was the escalation hole, `ai` never had an adapter.
    expect(source).not.toMatch(/\bbus:\s*\{/);
    expect(source).not.toMatch(/\bcache:\s*\{/);
    expect(source).not.toMatch(/\bai:\s*\{/);
  });

  /**
   * The bug this pins: each shim used to publish its own instance as `globalThis.synapseApi`. With
   * one world shared by every script, the LAST one evaluated owned that name — so any other script
   * calling through the global sent RPC under the winner's `moduleId`, i.e. ran with a different
   * script's identity and grants. Only visible once a second script exists, which is exactly what
   * Phase 2 enabled.
   */
  it('gives each script its OWN api object, never a shared global one', async () => {
    const captured: Record<string, unknown> = {};
    const capture = (name: string) =>
      `globalThis.__synapseModule = { id: '${name}', async run(i, ctx) { globalThis.captured['${name}'] = ctx.api; } };`;

    const ctx = sharedRealm();
    (ctx as { captured?: unknown }).captured = captured;
    evaluateAll([buildShimSource('uuid-a', capture('a')), buildShimSource('uuid-b', capture('b'))], ctx);
    await new Promise((resolve) => setTimeout(resolve, 0)); // run() is deferred through a microtask

    expect(captured.a).toBeDefined();
    expect(captured.b).toBeDefined();
    expect(captured.a).not.toBe(captured.b);
    expect(captured.a).not.toBe((ctx as { synapseApi?: unknown }).synapseApi);
  });

  it('leaves a stub under the old global name that explains itself instead of acting as a neighbour', async () => {
    const ctx = evaluateAll([buildShimSource('uuid-a', ''), buildShimSource('uuid-b', '')]);
    const global = (ctx as { synapseApi: { storage: { get(k: string): Promise<unknown> } } }).synapseApi;

    await expect(global.storage.get('x')).rejects.toThrow(/not a global[\s\S]*ctx\.api/);
  });

  /**
   * The bug this pins, found on real Chrome and older than Phase 2: `rpc-handler.ts` replies with
   * `sendResponse()`, which resolves the SENDER's `sendMessage` promise — it does not broadcast
   * anything. The shim used to ignore that promise and wait for an inbound `'synapse:rpc-result'`
   * message instead, so every call hung forever with no error in any console. The old shape passed
   * every "does the source look right" assertion, which is why this test drives a real round trip
   * rather than inspecting the generated text.
   */
  describe('RPC round trip', () => {
    const callAndReport = `
      globalThis.__synapseModule = {
        id: 'x',
        async run(input, ctx) {
          try { globalThis.result = { ok: await ctx.api.storage.get('k') }; }
          catch (err) { globalThis.result = { error: err.message }; }
        },
      };`;

    async function runWith(reply: (req: any) => unknown): Promise<{ result: any; sent: any[] }> {
      const sent: any[] = [];
      const ctx = sharedRealm((m: any) => {
        sent.push(m);
        return m.type === 'synapse:rpc' ? Promise.resolve(reply(m)) : Promise.resolve();
      });
      evaluateAll([buildShimSource('uuid-a', callAndReport)], ctx);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { result: (ctx as any).result, sent };
    }

    it('resolves with the value the background sent back', async () => {
      const { result, sent } = await runWith((req) => ({ type: 'synapse:rpc-result', callId: req.callId, result: 42 }));

      expect(result).toEqual({ ok: 42 });
      const rpc = sent.find((m) => m.type === 'synapse:rpc');
      expect(rpc).toMatchObject({ moduleId: 'uuid-a', namespace: 'storage', method: 'get', args: ['k'] });
    });

    it('rejects with the background’s error message, so a denied scope surfaces at the call site', async () => {
      const { result } = await runWith((req) => ({
        type: 'synapse:rpc-result',
        callId: req.callId,
        error: 'Scope "storage.rw" is not granted for module "uuid-a"',
      }));

      expect(result).toEqual({ error: 'Scope "storage.rw" is not granted for module "uuid-a"' });
    });

    it('rejects rather than hanging when nothing answers at all', async () => {
      const { result } = await runWith(() => undefined);
      expect(result.error).toMatch(/no response from the extension background/);
    });
  });

  describe('ui (in-world namespace)', () => {
    /** Runs one script and hands back the `ctx.api` its `run()` was given. */
    async function captureApi(moduleId: string, context = sharedRealm()): Promise<any> {
      vm.runInContext(
        buildShimSource(
          moduleId,
          `globalThis.__synapseModule = { id: ${JSON.stringify(moduleId)}, run: (input, ctx) => { globalThis['captured_' + ${JSON.stringify(moduleId)}] = ctx.api; } };`,
        ),
        context,
      );
      // run() is invoked from a `.then()`, so it lands one microtask after evaluation.
      await new Promise((resolve) => setImmediate(resolve));
      return (context as any)[`captured_${moduleId}`];
    }

    it('exposes exactly the ui methods the catalog declares in-world', async () => {
      // The shim writes the DOM half of the compositor a second time (it cannot import the
      // extension's bundle), so the one thing that can drift is WHICH methods exist. Adding an entry
      // to API_METHODS and forgetting this file fails here rather than at some user's console.
      const expected = API_METHODS.filter((m) => m.namespace === 'ui' && m.transport === 'in-world')
        .map((m) => m.method)
        .sort();
      const api = await captureApi('uuid-ui');

      expect(Object.keys(api.ui).sort()).toEqual(expected);
      expect(expected.length).toBeGreaterThan(0);
    });

    it('gives two scripts sharing one world two different ui objects', async () => {
      // The same identity property the storage tests pin: a surface handle is bound to one script,
      // so neither can address the other's UI even by guessing its ids.
      const context = sharedRealm();
      const a = await captureApi('uuid-a', context);
      const b = await captureApi('uuid-b', context);

      expect(a.ui).not.toBe(b.ui);
    });

    it('makes the global guard THROW for ui rather than return a promise', async () => {
      const context = sharedRealm();
      await captureApi('uuid-a', context);
      const guard = (context as any).synapseApi;

      // Synchronous methods must fail synchronously: a rejected promise would read as truthy to a
      // script that checks the return value of toast() before assuming it drew something.
      expect(() => guard.ui.toast({ id: 'x', message: 'hi' })).toThrow(/not a global/);
    });
  });

  describe('lib (static-injected namespace)', () => {
    /**
     * In production, `globalThis.__synapseLib` is set by a SEPARATE `{ file }` entry
     * (`user-script-lib-payload.ts`, built via `?script&iife`) that `chrome-module-registry.ts`
     * lists BEFORE this shim's own `{ code }` entry in the same `chrome.userScripts.register` call
     * — Chrome runs a script's `js` array entries in order, in one execution, the same guarantee
     * `content_scripts.js` arrays give. This harness has no build step, so it stands in for that
     * entry by assigning the global directly, right before evaluating the shim — reproducing the
     * ordering the real two-entry registration guarantees, not the mechanism that produces it.
     */
    const FAKE_LIB = { hls: { parse: (text: string, baseUrl: string) => ({ kind: 'unknown', text, baseUrl }) } };

    async function captureApiWithLib(moduleId: string, context = sharedRealm()): Promise<any> {
      (context as any).__synapseLib = FAKE_LIB;
      vm.runInContext(
        buildShimSource(
          moduleId,
          `globalThis.__synapseModule = { id: ${JSON.stringify(moduleId)}, run: (input, ctx) => { globalThis['captured_' + ${JSON.stringify(moduleId)}] = ctx.api; } };`,
        ),
        context,
      );
      await new Promise((resolve) => setImmediate(resolve));
      return (context as any)[`captured_${moduleId}`];
    }

    it('hands the script exactly what user-script-lib-payload.ts set, via ctx.api.lib', async () => {
      const api = await captureApiWithLib('uuid-lib');
      expect(api.lib.hls.parse).toBe(FAKE_LIB.hls.parse);
      expect(api.lib.hls.parse('#EXTM3U', 'https://x.test/a.m3u8')).toEqual({
        kind: 'unknown',
        text: '#EXTM3U',
        baseUrl: 'https://x.test/a.m3u8',
      });
    });

    it('does NOT delete globalThis.__synapseLib — leaving it in place is what fixes the 2-script bug below', async () => {
      const context = sharedRealm();
      await captureApiWithLib('uuid-a', context);
      expect((context as any).__synapseLib).toBe(FAKE_LIB);
    });

    /**
     * Bugfix, found on real Chrome: with two scripts both registered against the same page (both
     * matching `<all_urls>`), the SECOND script's `ctx.api.lib` came back `undefined`. Root cause —
     * `{file: libPayloadPath}` is the exact same resource URL in both scripts' own `js` arrays, and
     * Chrome does not guarantee re-running it once per registration on a page where several scripts
     * share it. The old design captured `globalThis.__synapseLib` and immediately `delete`d it (on
     * the theory that every script's own `{file}` entry always re-sets it fresh first) — so whichever
     * script's shim ran second, after an earlier script's `{file}` entry either didn't re-fire or
     * simply lost the race to that earlier script's delete, got nothing. This models the exact
     * failure: only the FIRST script's `{file}` entry actually sets the global (the second script's
     * own copy of that entry is simulated as a no-op, matching what Chrome did) — the fix is that NOT
     * deleting means the second script can still read the first script's value, safely, because the
     * content is script-agnostic (see `user-script-lib-payload.ts`'s doc comment for why that's fine).
     */
    it('still hands ctx.api.lib to a second script whose own { file } entry did not fire, because the global is never deleted', async () => {
      const context = sharedRealm();
      await captureApiWithLib('uuid-a', context); // only this script's own {file} entry "ran"
      // uuid-b's {file} entry is simulated as a no-op — not re-assigning __synapseLib here — the
      // exact condition observed on real Chrome with 2 active scripts.
      vm.runInContext(
        buildShimSource('uuid-b', `globalThis.__synapseModule = { id: 'uuid-b', run: (input, ctx) => { globalThis.captured_b = ctx.api; } };`),
        context,
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect((context as any).captured_b.lib).toBe(FAKE_LIB);
      expect((context as any).captured_b.lib.hls.parse).toBe(FAKE_LIB.hls.parse);
    });

    it('makes the global guard THROW for lib.hls.parse rather than return a promise', async () => {
      const context = sharedRealm();
      await captureApiWithLib('uuid-a', context);
      const guard = (context as any).synapseApi;

      expect(() => guard.lib.hls.parse('#EXTM3U', 'https://x.test/')).toThrow(/not a global/);
    });
  });

  describe('media.onProgress (subscription-push spike, docs/api-inventory.md §6 item 8)', () => {
    async function captureApi(moduleId: string, context = sharedRealm()): Promise<any> {
      vm.runInContext(
        buildShimSource(
          moduleId,
          `globalThis.__synapseModule = { id: ${JSON.stringify(moduleId)}, run: (input, ctx) => { globalThis['captured_' + ${JSON.stringify(moduleId)}] = ctx.api; } };`,
        ),
        context,
      );
      await new Promise((resolve) => setImmediate(resolve));
      return (context as any)[`captured_${moduleId}`];
    }

    it('is synchronous and returns an unsubscribe function, like ui.*', async () => {
      const api = await captureApi('uuid-sub');
      const unsubscribe = api.media.onProgress('job-1', () => {});
      expect(typeof unsubscribe).toBe('function');
    });

    it('calls the handler when the relayed CustomEvent carries this jobId’s topic', async () => {
      const context = sharedRealm();
      const api = await captureApi('uuid-sub', context);
      const received: unknown[] = [];
      api.media.onProgress('job-1', (status: unknown) => received.push(status));

      (context as any).__dispatchSubscriptionEvent('media.progress:job-1', { phase: 'done' });

      expect(received).toEqual([{ phase: 'done' }]);
    });

    it('never calls a handler registered for a different jobId’s topic', async () => {
      const context = sharedRealm();
      const api = await captureApi('uuid-sub', context);
      const received: unknown[] = [];
      api.media.onProgress('job-1', (status: unknown) => received.push(status));

      (context as any).__dispatchSubscriptionEvent('media.progress:job-2', { phase: 'done' });

      expect(received).toEqual([]);
    });

    it('stops calling the handler once unsubscribed', async () => {
      const context = sharedRealm();
      const api = await captureApi('uuid-sub', context);
      const received: unknown[] = [];
      const unsubscribe = api.media.onProgress('job-1', (status: unknown) => received.push(status));
      unsubscribe();

      (context as any).__dispatchSubscriptionEvent('media.progress:job-1', { phase: 'done' });

      expect(received).toEqual([]);
    });

    it('keeps two scripts’ subscriptions on the shared window fully isolated from each other', async () => {
      const context = sharedRealm();
      const a = await captureApi('uuid-a', context);
      const b = await captureApi('uuid-b', context);
      const receivedA: unknown[] = [];
      const receivedB: unknown[] = [];
      a.media.onProgress('job-1', (status: unknown) => receivedA.push(status));
      b.media.onProgress('job-1', (status: unknown) => receivedB.push(status));

      (context as any).__dispatchSubscriptionEvent('media.progress:job-1', { phase: 'done' });

      expect(receivedA).toEqual([{ phase: 'done' }]);
      expect(receivedB).toEqual([{ phase: 'done' }]);
    });

    it('makes the global guard THROW for media.onProgress rather than return a promise', async () => {
      const context = sharedRealm();
      await captureApi('uuid-a', context);
      const guard = (context as any).synapseApi;

      expect(() => guard.media.onProgress('job-1', () => {})).toThrow(/not a global/);
    });
  });

  describe('RPC namespaces (structural coverage)', () => {
    /**
     * Guards against the exact bug found while adding `media`: a namespace present in
     * `API_METHODS` (so `rpc-handler.ts` accepts calls to it) but never wired into THIS file's own
     * `synapseApi` object literal — every RPC method reference here is hand-written, not generated
     * from the catalog, so nothing but a test catches the two drifting apart. `ctx.api.media` was
     * `undefined` for every uploaded script for a while with zero failing test, because no existing
     * test enumerated namespaces generically — only `ui` (an in-world namespace) had that coverage.
     * Built from `API_METHODS` itself, the same reasoning the `ui` coverage test above uses, so a
     * namespace/method added to the catalog and forgotten here fails here, not at a user's console.
     */
    function expectedShape(namespace: string): Record<string, unknown> {
      // NOT filtered to transport === 'rpc': `media` mixes transports (onProgress is 'in-world',
      // docs/api-inventory.md §6 item 8) since it lives on the same ctx.api.media object as the RPC
      // methods, so the real shim's actual keys include both — this has to build the same union or
      // the two would drift apart by construction, not by a bug either side introduced.
      const shape: Record<string, unknown> = {};
      for (const m of API_METHODS.filter((x) => x.namespace === namespace)) {
        const parts = m.method.split('.');
        let cur = shape;
        for (let i = 0; i < parts.length - 1; i++) {
          cur = (cur[parts[i]!] ??= {}) as Record<string, unknown>;
        }
        cur[parts[parts.length - 1]!] = true;
      }
      return shape;
    }

    function assertShape(actual: unknown, expected: Record<string, unknown>, path: string): void {
      expect(actual, path).toBeTypeOf('object');
      expect(Object.keys(actual as object).sort(), `${path} keys`).toEqual(Object.keys(expected).sort());
      for (const [key, value] of Object.entries(expected)) {
        if (value === true) {
          expect((actual as Record<string, unknown>)[key], `${path}.${key}`).toBeTypeOf('function');
        } else {
          assertShape((actual as Record<string, unknown>)[key], value as Record<string, unknown>, `${path}.${key}`);
        }
      }
    }

    const rpcNamespaces = [...new Set(API_METHODS.filter((m) => m.transport === 'rpc').map((m) => m.namespace))];

    it.each(rpcNamespaces)('ctx.api.%s exposes exactly the RPC methods the catalog declares', async (namespace) => {
      const context = sharedRealm();
      vm.runInContext(
        buildShimSource(
          'uuid-shape',
          `globalThis.__synapseModule = { id: 'uuid-shape', run: (input, ctx) => { globalThis.captured = ctx.api; } };`,
        ),
        context,
      );
      await new Promise((resolve) => setImmediate(resolve));
      const api = (context as { captured: Record<string, unknown> }).captured;
      assertShape(api[namespace], expectedShape(namespace), `api.${namespace}`);
    });
  });

  it('clears __synapseModule around the user’s code, so a script that declares none cannot inherit the previous one', () => {
    const context = evaluateAll([
      buildShimSource('a', USER_SOURCE),
      buildShimSource('b', 'const nothing = 1;'),
    ]);

    expect((context as { __synapseModule?: unknown }).__synapseModule).toBeUndefined();
  });

  describe('steps (docs/ROADMAP.md §12.3)', () => {
    /** Runs one script and hands back every message it sent plus the realm, once settled — the
     * realm lets a test read back a value a step stashed on `globalThis` to prove what input it
     * actually received, not just that it reported `ok`. */
    async function runAndCollect(
      userSource: string,
      subState: Record<string, boolean> = {},
    ): Promise<{ sent: any[]; ctx: vm.Context }> {
      const sent: any[] = [];
      const ctx = sharedRealm((m: any) => {
        sent.push(m);
        if (m.type === 'synapse:sub-state-query') return Promise.resolve({ subState });
        return Promise.resolve();
      });
      evaluateAll([buildShimSource('uuid-steps', userSource)], ctx);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { sent, ctx };
    }

    function reports(sent: any[]): any[] {
      return sent.filter((m) => m.type === 'synapse:manifest-report');
    }

    it('normalizes a bare run to a single "main" step, reported before it ever runs', async () => {
      const { sent } = await runAndCollect(`globalThis.__synapseModule = { id: 'x', async run() { return 1; } };`);
      const [first] = reports(sent);
      expect(first).toMatchObject({ hasRun: true, steps: [{ id: 'main' }] });
      expect(first.runError).toBeUndefined();
    });

    it('is invalid when both run and steps are declared', async () => {
      const { sent } = await runAndCollect(`
        globalThis.__synapseModule = {
          id: 'x',
          async run() { return 1; },
          steps: [{ id: 'a', async run(input) { return input; } }],
        };
      `);
      const [first] = reports(sent);
      expect(first).toMatchObject({ hasRun: false });
      expect(first.runError).toMatch(/either run or steps, not both/);
    });

    it('is invalid on a duplicate step id', async () => {
      const { sent } = await runAndCollect(`
        globalThis.__synapseModule = {
          id: 'x',
          steps: [
            { id: 'dup', async run(input) { return input; } },
            { id: 'dup', async run(input) { return input; } },
          ],
        };
      `);
      const [first] = reports(sent);
      expect(first.hasRun).toBe(false);
      expect(first.runError).toMatch(/duplicate step id "dup"/);
    });

    it('runs steps in declared order, each one’s output feeding the next', async () => {
      const { sent } = await runAndCollect(`
        globalThis.__synapseModule = {
          id: 'x',
          steps: [
            { id: 'seed', async run() { return 10; } },
            { id: 'double', async run(input) { return input * 2; } },
            { id: 'observe', async run(input) { globalThis.finalValue = input; return input; } },
          ],
        };
      `);
      const final = reports(sent).find((r) => r.stepResults);
      expect(final.stepResults.map((r: any) => r.id)).toEqual(['seed', 'double', 'observe']);
      expect(final.stepResults.every((r: any) => r.ok)).toBe(true);
    });

    it('bypasses a step via subState — its value passes through unchanged to the next step', async () => {
      const { sent, ctx } = await runAndCollect(
        `
        globalThis.__synapseModule = {
          id: 'x',
          steps: [
            { id: 'seed', async run() { return 10; } },
            { id: 'skip-me', async run(input) { return input * 100; } },
            { id: 'observe', async run(input) { globalThis.finalValue = input; return input; } },
          ],
        };
      `,
        { 'skip-me': false },
      );
      const final = reports(sent).find((r) => r.stepResults);
      expect(final.stepResults.find((r: any) => r.id === 'skip-me')).toMatchObject({ ok: true, skipped: true });
      // seed() returns 10; skip-me is bypassed, so observe() still receives 10, not 1000.
      expect((ctx as any).finalValue).toBe(10);
    });

    it('keeps running later steps after one throws, and surfaces the failure both per-step and at the top level', async () => {
      const { sent } = await runAndCollect(`
        globalThis.__synapseModule = {
          id: 'x',
          steps: [
            { id: 'ok-step', async run() { return 'seed'; } },
            { id: 'boom', async run() { throw new Error('kaboom'); } },
            { id: 'after', async run(input) { globalThis.afterInput = input; return input; } },
          ],
        };
      `);
      const final = reports(sent).find((r) => r.stepResults);
      expect(final.stepResults).toEqual([
        { id: 'ok-step', ok: true, durationMs: expect.any(Number) },
        { id: 'boom', ok: false, durationMs: expect.any(Number), error: 'kaboom' },
        { id: 'after', ok: true, durationMs: expect.any(Number) },
      ]);
      // The step after the failure still ran (no rollback, same as createCompositeModule) — with
      // the PREVIOUS value ('seed'), since 'boom' never resolved one of its own.
      expect(final.runError).toBe('kaboom');
    });

    it('queries the background for its own subState before running any step', async () => {
      const { sent } = await runAndCollect(`globalThis.__synapseModule = { id: 'x', async run() { return 1; } };`);
      const query = sent.find((m) => m.type === 'synapse:sub-state-query');
      expect(query).toMatchObject({ moduleId: 'uuid-steps' });
    });
  });
});
