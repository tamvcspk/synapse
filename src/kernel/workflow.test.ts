import { describe, expect, it } from 'vitest';
import { Kernel } from './index';
import { ServiceInjector } from './service-injector';
import { resolveWorkflowSteps, type Workflow } from './workflow';
import type { Module } from './module';

/**
 * Replaces the `append-a`/`append-b` smoke test that used to run — and `console.log` — inside the
 * background service worker on every single extension start (docs/ROADMAP.md §11.1). Same claim
 * being proven, now asserted instead of eyeballed in a console, and at zero cost to shipped builds.
 */
const appendModules: Module<string, string>[] = [
  { id: 'append-a', needs: [], async run(input) { return `${input} A`; } },
  { id: 'append-b', needs: [], async run(input) { return `${input} B`; } },
];
const lookup = (id: string) => appendModules.find((m) => m.id === id);

describe('resolveWorkflowSteps', () => {
  it('resolves ids in the Workflow’s declared order, NOT the module list’s order', () => {
    // 'append-a' sorts before 'append-b' alphabetically and comes first in `appendModules` — the
    // Workflow says b-then-a, and that is the only thing allowed to decide sequencing (design.md §2:
    // never rely on discovery/glob iteration order).
    const workflow: Workflow = { id: 'demo-chain', steps: ['append-b', 'append-a'] };
    const { modules, missing } = resolveWorkflowSteps(workflow, lookup);

    expect(modules.map((m) => m.id)).toEqual(['append-b', 'append-a']);
    expect(missing).toEqual([]);
  });

  it('reports unknown ids in `missing` rather than throwing or silently dropping them', () => {
    const workflow: Workflow = { id: 'partial', steps: ['append-a', 'nope', 'append-b', 'also-nope'] };
    const { modules, missing } = resolveWorkflowSteps(workflow, lookup);

    expect(modules.map((m) => m.id)).toEqual(['append-a', 'append-b']);
    expect(missing).toEqual(['nope', 'also-nope']);
  });

  it('keeps a repeated id repeated — steps are a sequence, not a set', () => {
    const workflow: Workflow = { id: 'twice', steps: ['append-a', 'append-a'] };
    expect(resolveWorkflowSteps(workflow, lookup).modules.map((m) => m.id)).toEqual(['append-a', 'append-a']);
  });

  it('resolves an empty step list to an empty pipeline', () => {
    expect(resolveWorkflowSteps({ id: 'empty', steps: [] }, lookup)).toEqual({ modules: [], missing: [] });
  });
});

describe('Kernel.run over a resolved Workflow', () => {
  const kernel = () => new Kernel(new ServiceInjector({}));

  it('feeds each module’s output into the next, in Workflow order', async () => {
    const { modules } = resolveWorkflowSteps({ id: 'demo-chain', steps: ['append-b', 'append-a'] }, lookup);
    await expect(kernel().run(modules, 'start')).resolves.toBe('start B A');
  });

  it('returns the initial input untouched for an empty pipeline', async () => {
    await expect(kernel().run([], 'start')).resolves.toBe('start');
  });

  it('reports a throwing module and passes the previous value through (graceful fail)', async () => {
    const failing: Module<string, string> = {
      id: 'boom',
      needs: [],
      async run() { throw new Error('exploded'); },
    };
    const failures: { moduleId: string; error: string }[] = [];

    const result = await kernel().run(
      [appendModules[0]!, failing, appendModules[1]!],
      'start',
      (f) => failures.push(f),
    );

    // 'boom' contributes nothing, but must not abort the chain — 'append-b' still runs on 'start A'.
    expect(result).toBe('start A B');
    expect(failures).toEqual([{ moduleId: 'boom', error: 'exploded' }]);
  });

  it('registers a bus-needing module as a listener instead of calling it in the pipeline', async () => {
    const seen: unknown[] = [];
    const handlers = new Map<string, (payload: unknown) => void>();
    const bus = {
      emit: (event: string, payload: unknown) => handlers.get(event)?.(payload),
      on: (event: string, handler: (payload: unknown) => void) => { handlers.set(event, handler); },
    };
    const busModule: Module = {
      id: 'listener',
      needs: ['bus'],
      async run(input) { seen.push(input); return input; },
    };

    const kernel = new Kernel(new ServiceInjector({ bus: () => bus }));
    const result = await kernel.run([busModule, appendModules[0]!], 'start');

    // The bus module is registered, never called directly — so it doesn't touch the pipeline value.
    expect(result).toBe('start A');
    expect(seen).toEqual([]);

    bus.emit('listener', { op: 'sync' });
    await Promise.resolve();
    expect(seen).toEqual([{ op: 'sync' }]);
  });
});
