import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildDryRunShimSource } from './dry-run-shim';

/**
 * Mirrors `user-script-shim.test.ts`'s own harness (same reasoning: `node:vm`'s `vm.runInContext`,
 * not `new Function`, models the one-shared-USER_SCRIPT-world realm a real `chrome.userScripts.execute`
 * call runs in). Adds `window.console` on top of that file's `fakeWindow()`, since
 * `consoleCaptureSource` reads `window.console` to build its shadow — the production shim never
 * touches `window.console` at all, so that file's harness never needed it.
 */
function fakeWindow(): { window: unknown; CustomEvent: unknown } {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const window = {
    console,
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
  };
  class CustomEvent {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  }
  return { window, CustomEvent };
}

function sharedRealm(sendMessage: (m: any) => unknown = () => Promise.resolve()): vm.Context {
  const { window, CustomEvent } = fakeWindow();
  return vm.createContext({
    chrome: { runtime: { sendMessage, onMessage: { addListener: () => {} } } },
    crypto,
    console,
    window,
    CustomEvent,
  });
}

async function run(userSource: string, opts: { moduleId?: string; subState?: Record<string, boolean> } = {}): Promise<{ sent: any[] }> {
  const sent: any[] = [];
  const ctx = sharedRealm((m: any) => {
    sent.push(m);
    if (m.type === 'synapse:sub-state-query') return Promise.resolve({ subState: opts.subState ?? {} });
    return Promise.resolve();
  });
  vm.runInContext(buildDryRunShimSource(opts.moduleId ?? 'dry-run:test', userSource, 'run-1'), ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { sent };
}

function logs(sent: any[]): any[] {
  return sent.filter((m) => m.type === 'synapse:dry-run-log');
}

function results(sent: any[]): any[] {
  return sent.filter((m) => m.type === 'synapse:dry-run-result');
}

describe('buildDryRunShimSource', () => {
  it('never sends synapse:manifest-report — a dry run must not overwrite the last confirmed run', async () => {
    const { sent } = await run(`globalThis.__synapseModule = { id: 'x', async run() { return 1; } };`);
    expect(sent.some((m) => m.type === 'synapse:manifest-report')).toBe(false);
  });

  it('reports a bare run as one "main" step, ok on success', async () => {
    const { sent } = await run(`globalThis.__synapseModule = { id: 'x', async run() { return 1; } };`);
    const [result] = results(sent);
    expect(result).toMatchObject({ runId: 'run-1', ok: true, steps: [{ id: 'main', ok: true }] });
  });

  it('is invalid the same way production is (both run and steps declared), tagged runId, no manifest-report', async () => {
    const { sent } = await run(`
      globalThis.__synapseModule = {
        id: 'x',
        async run() { return 1; },
        steps: [{ id: 'a', async run(input) { return input; } }],
      };
    `);
    const [result] = results(sent);
    expect(result).toMatchObject({ runId: 'run-1', ok: false });
    expect(result.error).toMatch(/either run or steps, not both/);
  });

  it('keeps running later steps after one throws, surfacing the failure per-step and at the top level', async () => {
    const { sent } = await run(`
      globalThis.__synapseModule = {
        id: 'x',
        steps: [
          { id: 'ok-step', async run() { return 'seed'; } },
          { id: 'boom', async run() { throw new Error('kaboom'); } },
          { id: 'after', async run(input) { return input; } },
        ],
      };
    `);
    const [result] = results(sent);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('kaboom');
    expect(result.steps).toEqual([
      { id: 'ok-step', ok: true, durationMs: expect.any(Number) },
      { id: 'boom', ok: false, durationMs: expect.any(Number), error: 'kaboom' },
      { id: 'after', ok: true, durationMs: expect.any(Number) },
    ]);
  });

  it('bypasses a step via subState, same as production', async () => {
    const { sent } = await run(
      `
      globalThis.__synapseModule = {
        id: 'x',
        steps: [
          { id: 'seed', async run() { return 10; } },
          { id: 'skip-me', async run(input) { return input * 100; } },
        ],
      };
    `,
      { subState: { 'skip-me': false } },
    );
    const [result] = results(sent);
    expect(result.steps.find((s: any) => s.id === 'skip-me')).toMatchObject({ ok: true, skipped: true });
  });

  it('threads the given moduleId into ctx.api calls — the mechanism that lets a dry run borrow an existing script’s grant', async () => {
    const { sent } = await run(
      `globalThis.__synapseModule = { id: 'x', scopes: ['storage.rw'], async run(input, ctx) { await ctx.api.storage.get('k').catch(() => {}); } };`,
      { moduleId: 'already-uploaded-id' },
    );
    const rpc = sent.find((m) => m.type === 'synapse:rpc');
    expect(rpc).toMatchObject({ moduleId: 'already-uploaded-id', namespace: 'storage', method: 'get' });
  });

  describe('console capture', () => {
    it('relays console.log as synapse:dry-run-log, tagged with runId and level', async () => {
      const { sent } = await run(`globalThis.__synapseModule = { id: 'x', run() { console.log('hello', 42); } };`);
      const [line] = logs(sent);
      expect(line).toMatchObject({ runId: 'run-1', level: 'log', text: 'hello 42' });
    });

    it('tags console.warn/console.error with their own level', async () => {
      const { sent } = await run(`globalThis.__synapseModule = { id: 'x', run() { console.warn('careful'); console.error('boom'); } };`);
      const [warnLine, errorLine] = logs(sent);
      expect(warnLine).toMatchObject({ level: 'warn', text: 'careful' });
      expect(errorLine).toMatchObject({ level: 'error', text: 'boom' });
    });

    it('does not leak the console shadow out of its own IIFE into the shared realm’s global console', async () => {
      // The shadowing `var console` lives inside `buildDryRunShimSource`'s own `(function () {...})()`
      // wrapper (the same IIFE `header()`'s tests already pin as isolating __SYNAPSE_MODULE_ID__/
      // synapseApi) — this pins that the realm's OWN global `console` binding (provided to
      // `vm.createContext`) is left exactly as it was, not replaced by the shadow.
      const ctx = sharedRealm();
      const realConsole = (ctx as { console?: unknown }).console;
      vm.runInContext(buildDryRunShimSource('a', `globalThis.__synapseModule = { id: 'a', run() { console.log('from a'); } };`, 'run-a'), ctx);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect((ctx as { console?: unknown }).console).toBe(realConsole);
    });
  });
});
