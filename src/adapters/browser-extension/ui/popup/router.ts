import type { RegistryEntry } from '../../../../kernel/module-registry';
import type { SynapseScopeGrant } from '../../../../kernel/synapse-api';
import { renderListView, type ListViewProps, type ModuleListTab } from './views/list-view';
import { renderActionResultView } from './views/action-result-view';
import { renderScopeConsentView } from './views/scope-consent-view';
import { renderBusyView } from './views/busy-view';
import { renderRenameView } from './views/rename-view';
import { renderConfirmDeleteView } from './views/confirm-delete-view';

/**
 * The popup's single source of navigation state (docs/ROADMAP.md #2 Navigation Flow). Every kind
 * renders as an in-flow view swapped into #root — none of them are native <dialog>s, since a
 * Chrome MV3 popup's auto-sizing doesn't grow for top-layer content (see
 * .claude/skills/module-registry/SKILL.md). Collection-schema modules ('management'/'item-form')
 * moved out to the Dashboard page (docs/ROADMAP.md #2.5, `dashboard/`) — this popup only ever
 * triggers `chrome.tabs.create` for that case now, it doesn't render the CRUD flow itself.
 */
export type View =
  | { kind: 'list' }
  /** `showReloadExtension` (docs/ROADMAP.md §12.1) — an extra "Reload extension" button, shown
   * only for the "Allow User Scripts" was just enabled but chrome.userScripts is still unavailable
   * to THIS running extension instance" case: Chrome doesn't always pick up a just-granted
   * permission for an already-running service worker, and `chrome.runtime.reload()` is the cheap
   * first thing to try before resorting to restarting the whole browser. */
  | { kind: 'action-result'; title: string; content: string; isError: boolean; showReloadExtension?: boolean }
  /** docs/ROADMAP.md §11.3 — scope consent, replacing the old capability consent. `scopes` is what
   * still needs approving (not everything the Module declared), and the view splits it into
   * Enforced vs Disclosed itself. */
  | { kind: 'scope-consent'; moduleId: string; moduleLabel?: string; scopes: SynapseScopeGrant[]; intent: 'toggle' | 'grant' }
  /** Shown immediately on any action trigger (docs/ROADMAP.md #1) — most actions resolve in a
   * second or two and this just flashes briefly, but a long-running one (Crawl & Convert Site)
   * updates `message` with progress pings so there's a clear signal to wait rather than click
   * away (closing the popup mid-request loses the response — see main.ts's progress listener). */
  | { kind: 'busy'; message: string }
  /** Vòng đời script (docs/ROADMAP.md §12.1) — rename and delete each get their own in-flow view
   * for the same "no native dialog in this popup" reason as scope-consent above. */
  | { kind: 'rename'; moduleId: string; currentLabel: string }
  | { kind: 'confirm-delete'; moduleId: string; label: string };

/** Handlers own all business logic (writes, state transitions) and are defined in main.ts, which
 * closes over `entries`/`view`/`load` — router.ts only decides "given state, what's on screen,"
 * including per-view read-side data fetching (list() calls), never writes. */
export interface RouterHandlers {
  onToggle(entry: RegistryEntry): void;
  onToggleUi(entry: RegistryEntry): void;
  onGrant(entry: RegistryEntry): void;
  onUpload(): void;
  onNewScript(): void;
  onRefresh(): void;
  onOpenModule(entry: RegistryEntry, actionId?: string): void;
  onOpenSteps(entry: RegistryEntry): void;
  onNavigate(next: View): void;
  onConsentApprove(): void;
  onConsentDeny(): void;
  onRename(entry: RegistryEntry): void;
  onEdit(entry: RegistryEntry): void;
  onDownload(entry: RegistryEntry): void;
  onDelete(entry: RegistryEntry): void;
  /** "Clone" on a read-only builtin (docs/ROADMAP.md §12.4) — opens Studio's "New script" flow
   * pre-filled from `entry.templateId`'s template. Only ever called for `entry.source === 'bundled'`
   * with a `templateId`; `list-view.ts` doesn't render the button otherwise. */
  onClone(entry: RegistryEntry): void;
  /** Builtin/Scripts tab switch (docs/ROADMAP.md §12.4) — see `ListViewCallbacks.onTabChange`. */
  onTabChange(tab: ModuleListTab): void;
  onRenameSave(label: string): void;
  onDeleteConfirm(): void;
  onReloadExtension(): void;
}

export async function render(
  root: HTMLElement,
  view: View,
  entries: RegistryEntry[],
  handlers: RouterHandlers,
  listProps: ListViewProps,
): Promise<void> {
  if (view.kind === 'list') {
    renderListView(
      root,
      entries,
      {
        onToggle: handlers.onToggle,
        onToggleUi: handlers.onToggleUi,
        onGrant: handlers.onGrant,
        onUpload: handlers.onUpload,
        onNewScript: handlers.onNewScript,
        onRefresh: handlers.onRefresh,
        onOpenModule: handlers.onOpenModule,
        onOpenSteps: handlers.onOpenSteps,
        onRename: handlers.onRename,
        onEdit: handlers.onEdit,
        onDownload: handlers.onDownload,
        onDelete: handlers.onDelete,
        onClone: handlers.onClone,
        onTabChange: handlers.onTabChange,
      },
      listProps,
    );
    return;
  }

  if (view.kind === 'action-result') {
    renderActionResultView(root, view, {
      onBack: () => handlers.onNavigate({ kind: 'list' }),
      onReloadExtension: handlers.onReloadExtension,
    });
    return;
  }

  if (view.kind === 'busy') {
    renderBusyView(root, view);
    return;
  }

  if (view.kind === 'rename') {
    renderRenameView(
      root,
      { currentLabel: view.currentLabel },
      { onSave: handlers.onRenameSave, onCancel: () => handlers.onNavigate({ kind: 'list' }) },
    );
    return;
  }

  if (view.kind === 'confirm-delete') {
    renderConfirmDeleteView(
      root,
      { label: view.label },
      { onConfirm: handlers.onDeleteConfirm, onCancel: () => handlers.onNavigate({ kind: 'list' }) },
    );
    return;
  }

  // view.kind === 'scope-consent'
  renderScopeConsentView(root, view, {
    onApprove: handlers.onConsentApprove,
    onDeny: handlers.onConsentDeny,
  });
}
