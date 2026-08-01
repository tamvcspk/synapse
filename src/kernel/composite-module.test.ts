import { describe, expect, it } from 'vitest';
import { createCompositeModule } from './composite-module';
import type { Module, ModuleContext, ModuleFailure } from './module';
import { ServiceInjector } from './service-injector';

/**
 * Replaces the `demo-composite` smoke test that used to run inside the background service worker on
 * every extension start (docs/ROADMAP.md §11.1) — same claims (sequential dispatch, per-step bypass,
 * no-rollback failure handling), now asserted rather than printed to a console nobody was reading.
 */
const append = (letter: string): Module<string, string> => ({
  id: `append-${letter.toLowerCase()}`,
  needs: [],
  async run(input) { return `${input} ${letter}`; },
});

/** `api` (docs/ROADMAP.md §11.3) is built by the Adapter; a Kernel test has no host for it, and
 * `ServiceInjector`'s own stub is the honest stand-in — every method rejects rather than
 * silently resolving `undefined`. */
const emptyCtx: ModuleContext = new ServiceInjector({}).resolve();

describe('createCompositeModule — the composed Module’s own shape', () => {
  it('declares the union of its sub-modules’ needs', () => {
    const composite = createCompositeModule({
      id: 'c',
      subModules: [
        { id: 'a', needs: ['cache'], async run(i) { return i; } },
        { id: 'b', needs: ['cache', 'bus'], async run(i) { return i; } },
        { id: 'c-sub', async run(i) { return i; } },
      ],
    });

    expect(composite.needs).toEqual(['cache', 'bus']);
  });

  it('exposes sub-modules as declarative metadata for the Registry UI, carrying labels through', () => {
    const composite = createCompositeModule({
      id: 'c',
      label: 'Composite',
      subModules: [{ id: 'a', label: 'Step A', async run(i) { return i; } }, { id: 'b', async run(i) { return i; } }],
    });

    expect(composite.label).toBe('Composite');
    expect(composite.subModules).toEqual([{ id: 'a', label: 'Step A' }, { id: 'b' }]);
  });

  it('omits optional fields entirely rather than setting them undefined', () => {
    const composite = createCompositeModule({ id: 'c', subModules: [] });
    expect('label' in composite).toBe(false);
    expect('description' in composite).toBe(false);
    expect('uiSchema' in composite).toBe(false);
  });
});

describe('createCompositeModule — run()', () => {
  it('runs sub-modules in declaration order, feeding each output to the next', async () => {
    const composite = createCompositeModule({ id: 'c', subModules: [append('A'), append('B')] });
    await expect(composite.run('start', emptyCtx)).resolves.toBe('start A B');
  });

  it('returns the input unchanged when there are no sub-modules', async () => {
    const composite = createCompositeModule({ id: 'c', subModules: [] });
    await expect(composite.run('start', emptyCtx)).resolves.toBe('start');
  });

  it('forwards the same ctx to every sub-module (no per-step context rewriting)', async () => {
    const seen: ModuleContext[] = [];
    const spy: Module = { id: 'spy', async run(input, ctx) { seen.push(ctx); return input; } };
    const composite = createCompositeModule({ id: 'c', subModules: [spy, spy] });
    const ctx: ModuleContext = {
      ...emptyCtx,
      services: { cache: { async get() { return undefined; }, async set() {} } },
    };

    await composite.run('x', ctx);
    expect(seen).toEqual([ctx, ctx]);
  });
});

describe('createCompositeModule — per-step bypass (RegistryEntry.subState)', () => {
  const composite = (getSubState?: () => Promise<Record<string, boolean> | undefined>) =>
    createCompositeModule({
      id: 'c',
      subModules: [append('A'), append('B')],
      ...(getSubState ? { getSubState } : {}),
    });

  it('skips a step whose state is explicitly false, letting the value pass through untouched', async () => {
    const mod = composite(async () => ({ 'append-b': false }));
    await expect(mod.run('start', emptyCtx)).resolves.toBe('start A');
  });

  it('treats an absent callback, an undefined map, and a missing key all as "not bypassed"', async () => {
    await expect(composite().run('start', emptyCtx)).resolves.toBe('start A B');
    await expect(composite(async () => undefined).run('start', emptyCtx)).resolves.toBe('start A B');
    await expect(composite(async () => ({})).run('start', emptyCtx)).resolves.toBe('start A B');
    // Only `false` bypasses — `true` is the normal active state, not a second bypass spelling.
    await expect(composite(async () => ({ 'append-b': true })).run('start', emptyCtx)).resolves.toBe('start A B');
  });

  it('re-reads the bypass map on every run, so a toggle takes effect without re-creating the Module', async () => {
    let bypassB = false;
    const mod = composite(async () => (bypassB ? { 'append-b': false } : {}));

    await expect(mod.run('start', emptyCtx)).resolves.toBe('start A B');
    bypassB = true;
    await expect(mod.run('start', emptyCtx)).resolves.toBe('start A');
  });
});

describe('createCompositeModule — failure handling (report, never abort, never roll back)', () => {
  const boom: Module<string, string> = {
    id: 'boom',
    async run() { throw new Error('exploded'); },
  };

  it('reports a throwing step and keeps going with the previous value', async () => {
    const failures: ModuleFailure[] = [];
    const composite = createCompositeModule({
      id: 'c',
      subModules: [append('A'), boom, append('B')],
      onSubFailure: (f) => failures.push(f),
    });

    await expect(composite.run('start', emptyCtx)).resolves.toBe('start A B');
    expect(failures).toEqual([{ moduleId: 'boom', error: 'exploded' }]);
  });

  it('swallows a step failure even with no onSubFailure callback — run() must not reject', async () => {
    const composite = createCompositeModule({ id: 'c', subModules: [boom, append('B')] });
    await expect(composite.run('start', emptyCtx)).resolves.toBe('start B');
  });

  it('stringifies a non-Error throw instead of losing it', async () => {
    const failures: ModuleFailure[] = [];
    const composite = createCompositeModule({
      id: 'c',
      subModules: [{ id: 'thrower', async run() { throw 'just a string'; } }],
      onSubFailure: (f) => failures.push(f),
    });

    await composite.run('start', emptyCtx);
    expect(failures).toEqual([{ moduleId: 'thrower', error: 'just a string' }]);
  });
});
