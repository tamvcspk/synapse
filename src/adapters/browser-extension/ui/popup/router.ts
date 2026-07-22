import type { Capability } from '../../../../kernel/module';
import type { RegistryEntry } from '../../../../kernel/module-registry';
import { renderListView, type ListViewProps } from './views/list-view';
import { renderActionResultView } from './views/action-result-view';
import { renderCapabilityConsentView } from './views/capability-consent-view';

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

  // view.kind === 'capability-consent'
  renderCapabilityConsentView(root, view, {
    onApprove: handlers.onConsentApprove,
    onDeny: handlers.onConsentDeny,
  });
}
