import '@picocss/pico/css/pico.min.css';
import './popup.css';
import type { RegistryEntry } from '../../../../kernel/module-registry';
import { ungrantedScopes } from '../../../../kernel/scopes';
import { isCollectionSchema } from '../../../../kernel/ui-schema';
import { resolveScriptFileName } from '../../../../shared/resolve-script-label';
import { ChromeModuleRegistryService } from '../../module-registry/chrome-module-registry';
import { isUserScriptsPermissionGranted } from '../../module-registry/storage';
import { listenForActionProgress } from '../action-progress';
import { triggerModuleAction } from '../module-trigger';
import { openReviewPage } from '../review-handoff';
import { render as renderView, type RouterHandlers, type View } from './router';
import { DASHBOARD_PATH } from '../dashboard/dashboard-path';
import { REVIEW_PATH } from '../review-path';
import { STUDIO_PATH } from '../studio/studio-path';

const registry = new ChromeModuleRegistryService();
const root = document.getElementById('root')!;

let view: View = { kind: 'list' };
let entries: RegistryEntry[] = [];
let userScriptsPermissionGranted = true;

const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = '.js';
fileInput.style.display = 'none';
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;

  // `uploadModule`'s result used to be discarded, so a rejected `chrome.userScripts.register()`
  // (a syntax error in the file, or "Allow User Scripts" not enabled — in which case
  // `chrome.userScripts` is `undefined` and the property access throws) left the popup looking
  // exactly like a success: no new row, no message. That is the silent-failure shape this project
  // keeps paying for; the reason is now shown.
  const result = await registry.uploadModule(await file.text(), file.name);
  if (!result.ok) {
    navigate({ kind: 'action-result', title: `${file.name} — Upload failed`, content: result.reason ?? 'Unknown error', isError: true });
    return;
  }
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
  onToggleUi: handleToggleUi,
  onGrant: handleGrant,
  onUpload: () => fileInput.click(),
  onNewScript: () => openStudio(),
  onRefresh: handleRefresh,
  onOpenModule: handleOpenModule,
  onOpenSteps: handleOpenSteps,
  onNavigate: navigate,
  onConsentApprove: handleConsentApprove,
  onConsentDeny: () => navigate({ kind: 'list' }),
  onRename: (entry) => navigate({ kind: 'rename', moduleId: entry.id, currentLabel: entry.label ?? entry.id }),
  onEdit: openStudio,
  onDownload: handleDownload,
  onDelete: (entry) => navigate({ kind: 'confirm-delete', moduleId: entry.id, label: entry.label ?? entry.id }),
  onRenameSave: handleRenameSave,
  onDeleteConfirm: handleDeleteConfirm,
};

// Navigation Flow (docs/ROADMAP.md #2, extended by #2.5): a Collection schema opens the Dashboard
// page in its own Tab (no longer an in-popup view — see DASHBOARD_PATH above); an Action schema
// (no persisted collection, e.g. reader-mode-converter) triggers run() directly and shows the
// result in place, per the schema's shape rather than a boolean flag.
/** Shared by the Collection-schema branch below and `handleOpenSteps` — both just need the
 * Dashboard tab open on this module's id, closing the popup right after. */
function openDashboard(entry: RegistryEntry): void {
  const url = `${chrome.runtime.getURL(DASHBOARD_PATH)}?moduleId=${encodeURIComponent(entry.id)}`;
  void chrome.tabs.create({ url });
  window.close();
}

function handleOpenSteps(entry: RegistryEntry): void {
  openDashboard(entry);
}

/** Opens Studio (docs/ROADMAP.md §12.2) — `moduleId` given edits that script, omitted opens "New
 * script" (a template, no upload required first). Same tab-open-then-close-popup shape as
 * `openDashboard`. */
function openStudio(entry?: RegistryEntry): void {
  const url = entry
    ? `${chrome.runtime.getURL(STUDIO_PATH)}?moduleId=${encodeURIComponent(entry.id)}`
    : chrome.runtime.getURL(STUDIO_PATH);
  void chrome.tabs.create({ url });
  window.close();
}

async function handleOpenModule(entry: RegistryEntry, actionId?: string): Promise<void> {
  const schema = entry.uiSchema;
  if (!schema) return;

  if (isCollectionSchema(schema)) {
    openDashboard(entry);
    return;
  }

  // Defaults to the first action — matches list-view.ts's own default for a plain label click.
  const action = schema.actions.find((a) => a.id === actionId) ?? schema.actions[0];
  if (!action) return;

  // Shown immediately — most actions resolve in a second or two, this just flashes briefly.
  navigate({ kind: 'busy', message: 'Running...' });
  const stopProgress = listenForActionProgress((progress) => navigate({ kind: 'busy', message: progress.message }));

  let result: Awaited<ReturnType<typeof triggerModuleAction>>;
  try {
    result = await triggerModuleAction(entry.id, { action: action.id });
  } finally {
    stopProgress();
  }

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

  if (action.resultView === 'files') {
    const outcome = await openReviewPage(result.data);
    if (!outcome.ok) {
      navigate({
        kind: 'action-result',
        title: `${entry.label ?? entry.id} — Error`,
        content: outcome.error ?? 'Unknown error',
        isError: true,
      });
      return;
    }
    const url = `${chrome.runtime.getURL(REVIEW_PATH)}?reviewId=${encodeURIComponent(outcome.reviewId!)}`;
    void chrome.tabs.create({ url });
    window.close();
    return;
  }

  const data = result.data as Record<string, unknown> | undefined;
  const title = typeof data?.title === 'string' ? data.title : (entry.label ?? entry.id);
  const content = typeof data?.markdown === 'string' ? data.markdown : JSON.stringify(data, null, 2);
  navigate({ kind: 'action-result', title, content, isError: false });
}

function handleGrant(entry: RegistryEntry): void {
  const ungranted = ungrantedScopes(entry.scopes, entry.grantedScopes);
  if (ungranted.length === 0) return;
  navigate({ kind: 'scope-consent', moduleId: entry.id, ...(entry.label ? { moduleLabel: entry.label } : {}), scopes: ungranted, intent: 'grant' });
}

function handleToggle(entry: RegistryEntry): void {
  if (entry.active) {
    void registry.deactivate(entry.id).then(load);
    return;
  }
  if (entry.scopes.length > 0) {
    navigate({ kind: 'scope-consent', moduleId: entry.id, ...(entry.label ? { moduleLabel: entry.label } : {}), scopes: entry.scopes, intent: 'toggle' });
    return;
  }
  void registry.activate(entry.id).then(load);
}

/** The "hide UI" valve (docs/ROADMAP.md §11.4) — separate from the on/off switch above on purpose:
 * this leaves the Module running and only takes its on-page widgets away. */
function handleToggleUi(entry: RegistryEntry): void {
  void registry.setUiHidden(entry.id, !entry.uiHidden).then(load);
}

async function handleConsentApprove(): Promise<void> {
  if (view.kind !== 'scope-consent') return;
  const { moduleId, scopes, intent } = view;
  const entry = entries.find((e) => e.id === moduleId);
  // Union with what was already approved — the consent view only ever asks about the delta, so
  // approving it must not revoke the rest. `grantScopes` ignores bundled ids by design.
  await registry.grantScopes(moduleId, [...(entry?.grantedScopes ?? []), ...scopes]);
  if (intent === 'toggle') await registry.activate(moduleId);
  view = { kind: 'list' };
  await load();
}

async function handleRefresh(): Promise<void> {
  await registry.refresh();
  await load();
}

/** docs/ROADMAP.md §12.1 — Blob + chrome.downloads.download, not `output.offscreen.ts`'s `data:`
 * URL trick: that trick exists only because an Offscreen Document lacks `chrome.downloads`, which
 * the popup already has (see review-zip.ts's `<a download>` for the codebase's other "already in a
 * real page" download, and files-save-host.ts's doc comment for why the `data:` route exists at all). */
async function handleDownload(entry: RegistryEntry): Promise<void> {
  const source = await registry.getUploadedSource(entry.id);
  if (source === undefined) return;
  const filename = resolveScriptFileName(entry.fileName, entry.label ?? entry.id);
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    await chrome.downloads.download({ url: blobUrl, filename });
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function handleRenameSave(label: string): Promise<void> {
  if (view.kind !== 'rename') return;
  await registry.renameScript(view.moduleId, label);
  view = { kind: 'list' };
  await load();
}

async function handleDeleteConfirm(): Promise<void> {
  if (view.kind !== 'confirm-delete') return;
  await registry.deleteScript(view.moduleId);
  view = { kind: 'list' };
  await load();
}

void load();
