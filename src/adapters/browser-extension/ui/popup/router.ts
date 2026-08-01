import type { RegistryEntry } from '../../../../kernel/module-registry';
import type { SynapseScopeGrant } from '../../../../kernel/synapse-api';
import { renderListView, type ListViewProps } from './views/list-view';
import { renderActionResultView } from './views/action-result-view';
import { renderScopeConsentView } from './views/scope-consent-view';
import { renderBusyView } from './views/busy-view';

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
  | { kind: 'action-result'; title: string; content: string; isError: boolean }
  /** docs/ROADMAP.md §11.3 — scope consent, replacing the old capability consent. `scopes` is what
   * still needs approving (not everything the Module declared), and the view splits it into
   * Enforced vs Disclosed itself. */
  | { kind: 'scope-consent'; moduleId: string; moduleLabel?: string; scopes: SynapseScopeGrant[]; intent: 'toggle' | 'grant' }
  /** Shown immediately on any action trigger (docs/ROADMAP.md #1) — most actions resolve in a
   * second or two and this just flashes briefly, but a long-running one (Crawl & Convert Site)
   * updates `message` with progress pings so there's a clear signal to wait rather than click
   * away (closing the popup mid-request loses the response — see main.ts's progress listener). */
  | { kind: 'busy'; message: string };

/** Handlers own all business logic (writes, state transitions) and are defined in main.ts, which
 * closes over `entries`/`view`/`load` — router.ts only decides "given state, what's on screen,"
 * including per-view read-side data fetching (list() calls), never writes. */
export interface RouterHandlers {
  onToggle(entry: RegistryEntry): void;
  onGrant(entry: RegistryEntry): void;
  onUpload(): void;
  onRefresh(): void;
  onOpenModule(entry: RegistryEntry, actionId?: string): void;
  onOpenSteps(entry: RegistryEntry): void;
  onNavigate(next: View): void;
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
        onOpenSteps: handlers.onOpenSteps,
      },
      listProps,
    );
    return;
  }

  if (view.kind === 'action-result') {
    renderActionResultView(root, view, { onBack: () => handlers.onNavigate({ kind: 'list' }) });
    return;
  }

  if (view.kind === 'busy') {
    renderBusyView(root, view);
    return;
  }

  // view.kind === 'scope-consent'
  renderScopeConsentView(root, view, {
    onApprove: handlers.onConsentApprove,
    onDeny: handlers.onConsentDeny,
  });
}
