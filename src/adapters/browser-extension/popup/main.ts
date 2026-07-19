import type { RegistryEntry } from '../../../kernel/module-registry';
import { isCollectionSchema } from '../../../kernel/ui-schema';
import { ChromeModuleRegistryService } from '../module-registry/chrome-module-registry';
import { isUserScriptsPermissionGranted } from '../module-registry/storage';
import { getModuleDataSource } from './module-data-sources';
import { triggerModuleAction } from './module-trigger';
import { render as renderView, type RouterHandlers, type View } from './router';

const registry = new ChromeModuleRegistryService();
const root = document.getElementById('root')!;

let view: View = { kind: 'list' };
let entries: RegistryEntry[] = [];
let userScriptsPermissionGranted = true;

// chrome.runtime.sendMessage (used for CRUD writes) doesn't wait for the background handler to
// finish, so a manual load() right after a write would race and show stale data — refresh
// reactively off whatever storage write the background Module ends up persisting instead. Generic
// across every module's storage key (not just http-error-mocker's), matching the Declarative UI
// Schema's module-agnostic popup.
chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName === 'local') void load();
});

const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = '.js';
fileInput.style.display = 'none';
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  await registry.uploadModule(await file.text());
  await load();
});
document.body.append(fileInput);

async function load(): Promise<void> {
  const [nextEntries, granted] = await Promise.all([registry.list(), isUserScriptsPermissionGranted()]);
  entries = nextEntries;
  userScriptsPermissionGranted = granted;
  await render();
}

async function render(): Promise<void> {
  await renderView(root, view, entries, handlers, { userScriptsPermissionGranted });
}

function navigate(next: View): void {
  view = next;
  void render();
}

const handlers: RouterHandlers = {
  onToggle: handleToggle,
  onGrant: handleGrant,
  onUpload: () => fileInput.click(),
  onRefresh: handleRefresh,
  onOpenModule: handleOpenModule,
  onNavigate: navigate,
  onManagementAdd: (moduleId) => navigate({ kind: 'item-form', moduleId }),
  onManagementEdit: handleManagementEdit,
  onManagementToggleActive: handleManagementToggleActive,
  onManagementDelete: handleManagementDelete,
  onItemFormSave: handleItemFormSave,
  onConsentApprove: handleConsentApprove,
  onConsentDeny: () => navigate({ kind: 'list' }),
};

function handleManagementToggleActive(moduleId: string, item: Record<string, unknown>): void {
  const entry = entries.find((e) => e.id === moduleId);
  const schema = entry?.uiSchema;
  const dataSource = getModuleDataSource(moduleId);
  if (!schema || !isCollectionSchema(schema) || !schema.activeField || !dataSource) return;
  dataSource.upsert({ ...item, [schema.activeField]: !item[schema.activeField] });
}

function handleManagementDelete(moduleId: string, item: Record<string, unknown>): void {
  const entry = entries.find((e) => e.id === moduleId);
  const schema = entry?.uiSchema;
  const dataSource = getModuleDataSource(moduleId);
  if (!schema || !isCollectionSchema(schema) || !dataSource) return;
  const idField = schema.idField ?? 'id';
  dataSource.delete(String(item[idField]));
}

function handleManagementEdit(moduleId: string, item: Record<string, unknown>): void {
  const entry = entries.find((e) => e.id === moduleId);
  const schema = entry?.uiSchema;
  const idField = schema && isCollectionSchema(schema) ? (schema.idField ?? 'id') : 'id';
  navigate({ kind: 'item-form', moduleId, itemId: String(item[idField]) });
}

function handleItemFormSave(moduleId: string, item: Record<string, unknown>): void {
  const dataSource = getModuleDataSource(moduleId);
  dataSource?.upsert(item);
  // Navigate back immediately per docs/ROADMAP.md #2 ("navigate to a form, don't pop up... save
  // then navigate back") — don't wait for the chrome.storage.onChanged round-trip, matching the
  // existing fire-and-forget upsert pattern.
  navigate({ kind: 'management', moduleId });
}

// Navigation Flow (docs/ROADMAP.md #2): a Collection schema opens the generic Management View; an
// Action schema (no persisted collection, e.g. reader-mode-converter) triggers run() directly and
// shows the result in place, per the schema's shape rather than a boolean flag.
async function handleOpenModule(entry: RegistryEntry): Promise<void> {
  const schema = entry.uiSchema;
  if (!schema) return;

  if (isCollectionSchema(schema)) {
    navigate({ kind: 'management', moduleId: entry.id });
    return;
  }

  const result = await triggerModuleAction(entry.id);
  if (!result.ok) {
    // "Could not establish connection. Receiving end does not exist." is Chrome's standard
    // message for "no content script listening in that tab" — friendlier prefix, but still show
    // the raw message rather than hiding it.
    const hint = result.error?.includes('Receiving end does not exist')
      ? 'This page could not be reached (try reloading the tab, or it may be a restricted page). '
      : '';
    navigate({ kind: 'action-result', title: `${entry.label ?? entry.id} — Error`, content: `${hint}${result.error ?? 'Unknown error'}`, isError: true });
    return;
  }

  const data = result.data as Record<string, unknown> | undefined;
  const title = typeof data?.title === 'string' ? data.title : (entry.label ?? entry.id);
  const content = typeof data?.markdown === 'string' ? data.markdown : JSON.stringify(data, null, 2);
  navigate({ kind: 'action-result', title, content, isError: false });
}

function handleGrant(entry: RegistryEntry): void {
  const ungranted = entry.needs.filter((n) => !entry.grantedCapabilities.includes(n));
  if (ungranted.length === 0) return;
  navigate({ kind: 'capability-consent', moduleId: entry.id, capabilities: ungranted, intent: 'grant' });
}

function handleToggle(entry: RegistryEntry): void {
  if (entry.active) {
    void registry.deactivate(entry.id).then(load);
    return;
  }
  if (entry.needs.length > 0) {
    navigate({ kind: 'capability-consent', moduleId: entry.id, capabilities: entry.needs, intent: 'toggle' });
    return;
  }
  void registry.activate(entry.id).then(load);
}

async function handleConsentApprove(): Promise<void> {
  if (view.kind !== 'capability-consent') return;
  const { moduleId, capabilities, intent } = view;
  const entry = entries.find((e) => e.id === moduleId);
  const grantedCapabilities = entry?.grantedCapabilities ?? [];
  await registry.grantCapabilities(moduleId, [...grantedCapabilities, ...capabilities]);
  if (intent === 'toggle') await registry.activate(moduleId);
  view = { kind: 'list' };
  await load();
}

async function handleRefresh(): Promise<void> {
  await registry.refresh();
  await load();
}

void load();
