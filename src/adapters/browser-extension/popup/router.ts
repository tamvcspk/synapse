import type { Capability } from '../../../kernel/module';
import type { RegistryEntry } from '../../../kernel/module-registry';
import { isCollectionSchema } from '../../../kernel/ui-schema';
import { getModuleDataSource } from './module-data-sources';
import { renderListView, type ListViewProps } from './views/list-view';
import { renderManagementView } from './views/management-view';
import { renderItemFormView } from './views/item-form-view';
import { renderActionResultView } from './views/action-result-view';
import { renderCapabilityConsentView } from './views/capability-consent-view';

/**
 * The popup's single source of navigation state (docs/ROADMAP.md #2 Navigation Flow). Every kind
 * renders as an in-flow view swapped into #root — none of them are native <dialog>s, since a
 * Chrome MV3 popup's auto-sizing doesn't grow for top-layer content (see
 * .claude/skills/module-registry/SKILL.md).
 */
export type View =
  | { kind: 'list' }
  | { kind: 'management'; moduleId: string }
  | { kind: 'item-form'; moduleId: string; itemId?: string }
  | { kind: 'action-result'; title: string; content: string; isError: boolean }
  | { kind: 'capability-consent'; moduleId: string; capabilities: Capability[]; intent: 'toggle' | 'grant' };

/** Handlers own all business logic (writes, state transitions) and are defined in main.ts, which
 * closes over `entries`/`view`/`load` — router.ts only decides "given state, what's on screen,"
 * including per-view read-side data fetching (list() calls), never writes. */
export interface RouterHandlers {
  onToggle(entry: RegistryEntry): void;
  onGrant(entry: RegistryEntry): void;
  onUpload(): void;
  onRefresh(): void;
  onOpenModule(entry: RegistryEntry): void;
  onNavigate(next: View): void;
  onManagementAdd(moduleId: string): void;
  onManagementEdit(moduleId: string, item: Record<string, unknown>): void;
  onManagementToggleActive(moduleId: string, item: Record<string, unknown>): void;
  onManagementDelete(moduleId: string, item: Record<string, unknown>): void;
  onItemFormSave(moduleId: string, item: Record<string, unknown>): void;
  onConsentApprove(): void;
  onConsentDeny(): void;
}

export async function render(
  root: HTMLElement,
  view: View,
  entries: RegistryEntry[],
  handlers: RouterHandlers,
  listProps: ListViewProps,
): Promise<void> {
  document.body.classList.toggle('wide', view.kind === 'management' || view.kind === 'item-form');

  if (view.kind === 'list') {
    renderListView(
      root,
      entries,
      {
        onToggle: handlers.onToggle,
        onGrant: handlers.onGrant,
        onUpload: handlers.onUpload,
        onRefresh: handlers.onRefresh,
        onOpenModule: handlers.onOpenModule,
      },
      listProps,
    );
    return;
  }

  if (view.kind === 'action-result') {
    renderActionResultView(root, view, { onBack: () => handlers.onNavigate({ kind: 'list' }) });
    return;
  }

  if (view.kind === 'capability-consent') {
    renderCapabilityConsentView(root, view, {
      onApprove: handlers.onConsentApprove,
      onDeny: handlers.onConsentDeny,
    });
    return;
  }

  // Both 'management' and 'item-form' need the same entry/schema/dataSource lookup.
  const entry = entries.find((e) => e.id === view.moduleId);
  const schema = entry?.uiSchema;
  const dataSource = entry && getModuleDataSource(entry.id);
  if (!entry || !schema || !isCollectionSchema(schema) || !dataSource) {
    handlers.onNavigate({ kind: 'list' });
    return;
  }

  if (view.kind === 'management') {
    const items = await dataSource.list();
    const callbacks: Parameters<typeof renderManagementView>[4] = {
      onBack: () => handlers.onNavigate({ kind: 'list' }),
      onAdd: () => handlers.onManagementAdd(entry.id),
      onEdit: (item) => handlers.onManagementEdit(entry.id, item),
      onDelete: (item) => handlers.onManagementDelete(entry.id, item),
    };
    if (schema.activeField) {
      callbacks.onToggleActive = (item) => handlers.onManagementToggleActive(entry.id, item);
    }
    renderManagementView(root, entry, schema, items, callbacks);
    return;
  }

  // view.kind === 'item-form'
  let existing: Record<string, unknown> | undefined;
  if (view.itemId) {
    const idField = schema.idField ?? 'id';
    const items = await dataSource.list();
    existing = items.find((i) => String(i[idField]) === view.itemId);
  }
  renderItemFormView(root, schema, existing, {
    onSave: (item) => handlers.onItemFormSave(entry.id, item),
    onCancel: () => handlers.onNavigate({ kind: 'management', moduleId: entry.id }),
  });
}
