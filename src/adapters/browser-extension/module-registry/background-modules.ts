import type { Module } from '../../../kernel/module';
import { validateModuleManifestShape } from '../../../kernel/manifest-validator';

/**
 * Auto-discovers browser-specific, non-dom Modules bundled under background/modules/<name>/index.ts
 * (docs/design.md §7) — the background-context counterpart to bundled-modules.ts's dom-module
 * discovery. Iteration order is meaningless for execution, same caveat as bundled-modules.ts.
 */
const globbed = import.meta.glob<Record<string, unknown>>('../background/modules/*/index.ts', {
  eager: true,
});

export const BACKGROUND_MODULES: Module[] = Object.values(globbed)
  .flatMap((ns) => Object.values(ns))
  .filter((candidate): candidate is Module => {
    const record = candidate as Record<string, unknown>;
    return typeof record?.run === 'function' && validateModuleManifestShape(candidate).valid;
  });
