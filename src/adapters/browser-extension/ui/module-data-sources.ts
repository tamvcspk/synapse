import type { CollectionCommand } from '../../../kernel/ui-schema';
import { BUNDLED_MODULES } from '../module-registry/bundled-modules';
import { BACKGROUND_MODULES } from '../module-registry/background-modules';

export interface ModuleDataSource {
  list(): Promise<Record<string, unknown>[]>;
  upsert(item: Record<string, unknown>): void;
  delete(id: string): void;
}

/** Wire format for a `'trigger'`-kind `UIRowAction` (kernel/ui-schema.ts, docs/ROADMAP.md #5.1) —
 * sent straight to the Module's own bus listener, bypassing `CollectionCommand` entirely, same
 * `{event, payload}` shape as `emitCollectionCommand` below but with a Module-defined `payload`
 * shape instead of the generic upsert/delete/sync one. */
export function emitRowActionTrigger(moduleId: string, op: string, id: string): void {
  chrome.runtime.sendMessage({ event: moduleId, payload: { op, id } });
}

/**
 * Wire format matching background/services/bus.ts (`{event, payload}` over
 * chrome.runtime.sendMessage) — generic across any collection-schema Module, so a new one never
 * needs its own bus-client file the way http-error-mocker used to (mock-config-bus-client.ts).
 */
function emitCollectionCommand(moduleId: string, command: CollectionCommand): void {
  chrome.runtime.sendMessage({ event: moduleId, payload: command });
}

/**
 * Generic glue between the Management View (docs/ROADMAP.md #2.5's Dashboard page) and any
 * Collection-schema Module's storage — auto-discovered via `BUNDLED_MODULES`/`BACKGROUND_MODULES`
 * (the same glob-based registries `chrome-module-registry.ts` builds `RegistryEntry`s from), never
 * a hardcoded per-id branch importing a specific module's storage file. A Module opts in purely by
 * declaring `listCollection` on itself (kernel/module.ts) — nothing in this Adapter needs editing
 * to add a new one. The write path (upsert/delete) was already generic via `CollectionCommand`;
 * this only fixes the read path's boundary violation.
 */
export function getModuleDataSource(id: string): ModuleDataSource | undefined {
  const mod = [...BUNDLED_MODULES, ...BACKGROUND_MODULES].find((m) => m.id === id);
  if (!mod?.listCollection) return undefined;

  const listCollection = mod.listCollection.bind(mod);
  return {
    list: () => listCollection(),
    upsert: (item) => emitCollectionCommand(id, { op: 'upsert', item }),
    delete: (itemId) => emitCollectionCommand(id, { op: 'delete', id: itemId }),
  };
}
