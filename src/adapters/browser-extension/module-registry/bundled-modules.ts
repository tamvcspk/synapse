import type { Module } from '../../../kernel/module';
import { validateModuleManifestShape } from '../../../kernel/manifest-validator';

/**
 * Auto-discovers Modules bundled under content-scripts/modules at build time.
 * Iteration order here is meaningless for execution — only Workflow.steps
 * (kernel/workflow.ts) determines chain order for sequential pipelines.
 */
const globbed = import.meta.glob<Record<string, unknown>>('../content-scripts/modules/**/*.module.ts', {
  eager: true,
});

export const BUNDLED_MODULES: Module[] = Object.values(globbed)
  .flatMap((ns) => Object.values(ns))
  .filter((candidate): candidate is Module => {
    const record = candidate as Record<string, unknown>;
    return typeof record?.run === 'function' && validateModuleManifestShape(candidate).valid;
  });
