import type { Module } from '../../../kernel/module';
import { validateModuleManifestShape } from '../../../kernel/manifest-validator';

/**
 * Auto-discovers browser-specific, non-dom Modules bundled under features/<feature>/*.background.ts
 * (docs/design.md §7, docs/ROADMAP.md §11.5) — the background-context counterpart to
 * bundled-modules.ts's dom-module discovery. Iteration order is meaningless for execution, same
 * caveat as bundled-modules.ts. The `.background.ts` suffix also sweeps in plain (non-Module)
 * background-only helper files that happen to live in the same feature directory (e.g.
 * mock-config-store.background.ts) — harmless, same as the old `index.ts`-based glob already
 * relying on the `typeof record?.run === 'function'` filter below to separate a real Module export
 * from anything else a globbed file happens to export.
 */
const globbed = import.meta.glob<Record<string, unknown>>('../features/*/**/*.background.ts', {
  eager: true,
});

export const BACKGROUND_MODULES: Module[] = Object.values(globbed)
  .flatMap((ns) => Object.values(ns))
  .filter((candidate): candidate is Module => {
    const record = candidate as Record<string, unknown>;
    return typeof record?.run === 'function' && validateModuleManifestShape(candidate).valid;
  });
