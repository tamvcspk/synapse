import type { CollectionCommand } from '../../../kernel/ui-schema';
import { getMockConfigs } from '../background/modules/http-error-mocker/mock-config-store';

export interface ModuleDataSource {
  list(): Promise<Record<string, unknown>[]>;
  upsert(item: Record<string, unknown>): void;
  delete(id: string): void;
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
 * Per-module glue between the generic Management View and each module's own storage/Bus wiring —
 * the only popup file allowed to know a specific module's domain type (e.g. MockConfig). `list()`
 * still reads via the module's own store, since storage shape is inherently per-module; only the
 * write path (upsert/delete) is generic.
 */
export function getModuleDataSource(id: string): ModuleDataSource | undefined {
  if (id === 'http-error-mocker') {
    return {
      list: async () => (await getMockConfigs()) as unknown as Record<string, unknown>[],
      upsert: (item) => emitCollectionCommand(id, { op: 'upsert', item }),
      delete: (itemId) => emitCollectionCommand(id, { op: 'delete', id: itemId }),
    };
  }
  return undefined;
}
