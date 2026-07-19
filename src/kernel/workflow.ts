import type { Module } from './module';

/**
 * Explicit, ordered chain of Module ids. This is the only thing that determines execution order
 * for chained/sequential Modules — auto-discovery (e.g. import.meta.glob over a modules folder)
 * only answers "what Modules exist" and its iteration order must never be relied on for sequencing.
 */
export interface Workflow {
  id: string;
  steps: string[];
}

export interface WorkflowResolution {
  modules: Module[];
  missing: string[];
}

export function resolveWorkflowSteps(
  workflow: Workflow,
  lookup: (id: string) => Module | undefined,
): WorkflowResolution {
  const modules: Module[] = [];
  const missing: string[] = [];
  for (const id of workflow.steps) {
    const mod = lookup(id);
    if (mod) modules.push(mod);
    else missing.push(id);
  }
  return { modules, missing };
}
