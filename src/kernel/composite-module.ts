import type { Module, ModuleContext, ModuleFailure } from './module';
import type { UISchema } from './ui-schema';

export interface CreateCompositeModuleOptions {
  id: string;
  label?: string;
  description?: string;
  /** Passed straight through to the returned Module, same as `label`/`description` — a Composite
   * Module can declare its own Declarative UI Schema (docs/ROADMAP.md #2) independently of its
   * `subModules` metadata (which drives the Registry's separate per-step bypass UI, #3). */
  uiSchema?: UISchema;
  /** Sub-modules run in this order — the only thing that decides sequencing (same rule as
   * Workflow.steps, docs/design.md §2: never rely on discovery/glob iteration order). */
  subModules: Module[];
  /**
   * Reads the current per-step bypass map (`RegistryEntry.subState`, docs/ROADMAP.md #3) at run
   * time. Injected rather than read directly so this file stays chrome.storage-agnostic — the
   * Adapter wires this to its own registry storage (see chrome-module-registry.ts). A sub-module
   * id missing from the map, or an absent callback entirely, defaults to "not bypassed".
   */
  getSubState?: () => Promise<Record<string, boolean> | undefined>;
  /**
   * A sub-module's `run()` throwing must not abort the rest of the chain and must not roll back
   * any state (docs/ROADMAP.md #3 — "Không có rollback"). Reported here instead of re-thrown,
   * mirroring `Scheduler.runPipeline`'s `onFailure` callback — closed over at construction since
   * `Module.run()`'s signature has no room for a per-call callback.
   */
  onSubFailure?: (failure: ModuleFailure) => void;
}

/**
 * Module Chain / Composite Module (docs/ROADMAP.md #3) — a single Module that satisfies the
 * ordinary `Module` interface (has `id`, `run()`) but internally runs a fixed, ordered list of
 * sub-modules in sequence: the output of one becomes the input of the next, exactly like
 * `Scheduler.runPipeline`. Deliberately sequential-only — no rollback, and no mutable state
 * shared between steps outside of `input`/`output` (Atomic Autonomy, docs/design.md §5); a
 * sub-module needing real shared state uses the ordinary `ai`/`cache`/`bus` capabilities already
 * present on `ctx`, not a new side-channel.
 */
export function createCompositeModule(options: CreateCompositeModuleOptions): Module {
  const needs = Array.from(new Set(options.subModules.flatMap((mod) => mod.needs ?? [])));

  return {
    id: options.id,
    ...(options.label ? { label: options.label } : {}),
    ...(options.description ? { description: options.description } : {}),
    ...(options.uiSchema ? { uiSchema: options.uiSchema } : {}),
    needs,
    subModules: options.subModules.map((mod) => (mod.label ? { id: mod.id, label: mod.label } : { id: mod.id })),
    async run(input: unknown, ctx: ModuleContext): Promise<unknown> {
      const subState = (await options.getSubState?.()) ?? {};
      let value = input;
      for (const sub of options.subModules) {
        if (subState[sub.id] === false) continue; // bypassed step — value passes through untouched
        try {
          value = await sub.run(value, ctx);
        } catch (err) {
          options.onSubFailure?.({ moduleId: sub.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return value;
    },
  };
}
