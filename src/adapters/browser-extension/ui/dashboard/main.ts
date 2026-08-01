import '@picocss/pico/css/pico.min.css';
import './dashboard.css';
import type { RegistryEntry } from '../../../../kernel/module-registry';
import { isCollectionSchema, type UICollectionSchema } from '../../../../kernel/ui-schema';
import { ChromeModuleRegistryService } from '../../module-registry/chrome-module-registry';
import { getModuleDataSource, emitRowActionTrigger, type ModuleDataSource } from '../module-data-sources';
import { renderManagementView } from './views/management-view';
import { renderItemFormView } from './views/item-form-view';
import { renderStepsView } from './views/steps-view';

/**
 * Dashboard page (docs/ROADMAP.md #2.5): a standalone Tab (opened via `chrome.tabs.create` from the
 * popup's list-view row icon) hosting the Collection-schema flow that used to live in the popup's
 * 'management'/'item-form' views — moved out entirely (not kept as a popup fallback, per the
 * decision recorded when this page was scaffolded) so there's exactly one renderer reading each
 * module's UISchema, not two drifting in parallel. Scoped to a single `?moduleId=` — this page has
 * no module list of its own; that stays the popup's job.
 */

const registry = new ChromeModuleRegistryService();
const root = document.getElementById('root')!;
const moduleId = new URLSearchParams(location.search).get('moduleId');

type View = { kind: 'management' } | { kind: 'item-form'; itemId?: string } | { kind: 'steps' };

let view: View = { kind: 'management' };
let entry: RegistryEntry | undefined;
let schema: UICollectionSchema | undefined;
let dataSource: ModuleDataSource | undefined;
let items: Record<string, unknown>[] = [];

// chrome.runtime.sendMessage (used for CRUD writes) doesn't wait for the background handler to
// finish, so a manual reload right after a write would race and show stale data — refresh
// reactively off whatever storage write the background Module ends up persisting instead, same
// pattern as popup/main.ts used before the Collection-schema flow moved here.
chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName === 'local') void load();
});

async function load(): Promise<void> {
  if (!moduleId) {
    renderError('No module specified — open this page via a module\'s Manage icon in the Synapse popup.');
    return;
  }

  const entries = await registry.list();
  entry = entries.find((e) => e.id === moduleId);
  schema = entry?.uiSchema && isCollectionSchema(entry.uiSchema) ? entry.uiSchema : undefined;
  dataSource = entry && getModuleDataSource(entry.id);

  if (!entry) {
    renderError(`Module "${moduleId}" was not found.`);
    return;
  }

  document.title = `Synapse — ${entry.label ?? entry.id}`;

  if (schema && dataSource) {
    items = await dataSource.list();
    if (view.kind === 'steps') view = { kind: 'management' };
    render();
    return;
  }

  // No Collection schema (e.g. an Action-schema Composite Module like Reader Mode Converter,
  // docs/ROADMAP.md #3) — the per-step bypass view is the only thing this page can show it.
  if (entry.subModules && entry.subModules.length > 0) {
    view = { kind: 'steps' };
    render();
    return;
  }

  renderError(`Module "${moduleId}" has no manageable collection or configurable steps.`);
}

function renderError(message: string): void {
  root.replaceChildren();
  const p = document.createElement('p');
  p.textContent = message;
  root.append(p);
}

function navigate(next: View): void {
  view = next;
  render();
}

function render(): void {
  if (!entry) return;
  const activeEntry = entry;
  const currentView = view;

  if (currentView.kind === 'steps') {
    renderStepsView(root, activeEntry, {
      onToggleSub: (subId, active) => {
        void registry.setSubModuleActive(activeEntry.id, subId, active).then(load);
      },
    });
    return;
  }

  if (!schema || !dataSource) return;
  const activeSchema = schema;
  const activeDataSource = dataSource;

  if (currentView.kind === 'management') {
    const idField = activeSchema.idField ?? 'id';
    const callbacks: Parameters<typeof renderManagementView>[4] = {
      onAdd: () => navigate({ kind: 'item-form' }),
      onEdit: (item) => navigate({ kind: 'item-form', itemId: String(item[idField]) }),
      // ManagementViewCallbacks' onDelete/onToggleActive predate the write path returning a real
      // Promise (docs/ROADMAP.md §11.5) and still type as `void` — a rejection here has no form
      // context to show it inline in (unlike onSave above), so it's at least logged instead of
      // becoming a silent, uncaught rejection in the console.
      onDelete: (item) => {
        void activeDataSource.delete(String(item[idField])).catch((err: unknown) => console.error('Synapse: delete failed', err));
      },
      onTrigger: (op, item) => emitRowActionTrigger(activeEntry.id, op, String(item[idField])),
    };
    if (activeSchema.activeField) {
      const activeField = activeSchema.activeField;
      callbacks.onToggleActive = (item) => {
        void activeDataSource
          .upsert({ ...item, [activeField]: !item[activeField] })
          .catch((err: unknown) => console.error('Synapse: toggle active failed', err));
      };
    }
    renderManagementView(root, activeEntry, activeSchema, items, callbacks);
    return;
  }

  const idField = activeSchema.idField ?? 'id';
  const existing = currentView.itemId
    ? items.find((i) => String(i[idField]) === currentView.itemId)
    : undefined;
  renderItemFormView(root, activeSchema, existing, {
    // Navigates only after upsert() actually resolves (docs/ROADMAP.md §11.5) — a rejection (the
    // Module's own validation, e.g. shared/http-mock.ts's validateMockConfig, threw) propagates
    // out of this async function, which item-form-view.ts's Save handler catches and displays
    // instead of navigating away as if nothing had gone wrong.
    onSave: async (item) => {
      await activeDataSource.upsert(item);
      navigate({ kind: 'management' });
    },
    onCancel: () => navigate({ kind: 'management' }),
  });
}

void load();
