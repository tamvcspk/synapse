import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
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
function sharedRealm(sendMessage: (m: any) => unknown = () => Promise.resolve()): vm.Context {
  return vm.createContext({
    chrome: { runtime: { sendMessage, onMessage: { addListener: () => {} } } },
    crypto,
    console,
  });
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

  it('clears __synapseModule around the user’s code, so a script that declares none cannot inherit the previous one', () => {
    const context = evaluateAll([
      buildShimSource('a', USER_SOURCE),
      buildShimSource('b', 'const nothing = 1;'),
    ]);

    expect((context as { __synapseModule?: unknown }).__synapseModule).toBeUndefined();
  });
});
