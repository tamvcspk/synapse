import type { Module } from '../../../kernel/module';
import { validateModuleManifestShape } from '../../../kernel/manifest-validator';

/**
 * Auto-discovers dom Modules bundled under features/<feature>/*.module.ts at build time
 * (docs/ROADMAP.md §11.5). Iteration order here is meaningless for execution — only
 * Workflow.steps (kernel/workflow.ts) determines chain order for sequential pipelines.
 *
 * Deliberately kept narrow to the `.module.ts` suffix rather than broadened to the generic
 * `.content.ts` execution-context suffix (docs/ROADMAP.md §11.5) — this glob's result is imported
 * by content-scripts/index.ts, a *different* Rollup content-script entry than the plain
 * `.content.ts` helper files that live alongside a dom Module in the same feature directory (e.g.
 * dom-media-observer.content.ts, wired instead into the separate `all_frames` entry via
 * frame-media-observer.content.ts). Matching those too would silently bundle their code into a
 * chunk that doesn't need it. `.module.ts` stays reserved for "is a dom Module, auto-register it";
 * `.content.ts` alone means only "runs in the ISOLATED content-script world".
 */
const globbed = import.meta.glob<Record<string, unknown>>('../features/*/**/*.module.ts', {
  eager: true,
});

export const BUNDLED_MODULES: Module[] = Object.values(globbed)
  .flatMap((ns) => Object.values(ns))
  .filter((candidate): candidate is Module => {
    const record = candidate as Record<string, unknown>;
    return typeof record?.run === 'function' && validateModuleManifestShape(candidate).valid;
  });
