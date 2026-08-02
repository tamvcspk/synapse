import van from 'vanjs-core';
import type { RegistryEntry } from '../../../../../kernel/module-registry';
import { ungrantedScopes } from '../../../../../kernel/scopes';

const { div, nav, ul, li, strong, button, span, input } = van.tags;

export interface ListViewCallbacks {
  onToggle(entry: RegistryEntry): void;
  /** The "hide UI" valve (docs/ROADMAP.md §11.4) — hides the Module's on-page widgets while leaving
   * it running. Distinct from `onToggle`, which stops the Module entirely. */
  onToggleUi(entry: RegistryEntry): void;
  onGrant(entry: RegistryEntry): void;
  onUpload(): void;
  onRefresh(): void;
  /** Navigation Flow (docs/ROADMAP.md #2): row/icon click for any entry carrying a uiSchema —
   * router.ts decides whether that means "open Management View" or "trigger run() directly". For
   * an Action schema with more than one action (docs/ROADMAP.md #1's Crawl & Convert Site),
   * `actionId` picks which one; omitted for a Collection schema (only one thing to open) or when
   * defaulting to the first action (e.g. clicking the row label itself). */
  onOpenModule(entry: RegistryEntry, actionId?: string): void;
  /** Composite Module (docs/ROADMAP.md #3): opens the Dashboard's per-step toggle view — a
   * separate action from `onOpenModule` since a Composite Module's own `uiSchema` (if any) can be
   * an Action schema (triggers run() directly), independent of whether it also has sub-steps to
   * configure. Only shown when `entry.subModules` is non-empty. */
  onOpenSteps(entry: RegistryEntry): void;
  /** Vòng đời script (docs/ROADMAP.md §12.1) — only ever shown for `entry.source === 'uploaded'`;
   * a bundled Module's identity/code lives in the extension build, not here. */
  onRename(entry: RegistryEntry): void;
  onDownload(entry: RegistryEntry): void;
  onDelete(entry: RegistryEntry): void;
}

export interface ListViewProps {
  /** false when chrome.userScripts.configureWorld failed — see background/index.ts + storage.ts. */
  userScriptsPermissionGranted?: boolean;
}

/** Main Registry View — single list view by design. */
export function renderListView(
  root: HTMLElement,
  entries: RegistryEntry[],
  callbacks: ListViewCallbacks,
  props: ListViewProps = {},
): void {
  root.replaceChildren();

  van.add(
    root,
    props.userScriptsPermissionGranted === false
      ? div(
          { class: 'banner' },
          'Enable "Allow User Scripts" for this extension in chrome://extensions to run uploaded modules.',
        )
      : null,
    nav(
      ul(li(strong('Synapse Modules'))),
      ul(
        li(button({ title: 'Upload script', onclick: callbacks.onUpload }, '⬆')),
        li(button({ title: 'Refresh', onclick: callbacks.onRefresh }, '⟳')),
      ),
    ),
    ul({ class: 'module-list' }, ...entries.map((entry) => renderModuleRow(entry, callbacks))),
  );
}

/**
 * The "hide UI" valve (docs/ROADMAP.md §11.4), shown only for Modules that actually draw on the
 * page — a row that never renders anything would just be one more control to read past, and this
 * popup is a small fixed-width window.
 *
 * Two ways to qualify, because the two kinds of Module declare it differently: a bundled Module says
 * so with `uiParadigm: 'float-widget'`, an uploaded script by requesting the `ui.render` scope.
 */
function uiValveButton(entry: RegistryEntry, callbacks: ListViewCallbacks): HTMLElement | null {
  const drawsOnPage =
    entry.uiParadigm === 'float-widget' || entry.scopes.some((grant) => grant.scope === 'ui.render');
  if (!drawsOnPage || entry.status !== 'ok') return null;

  return button(
    {
      class: 'ui-valve' + (entry.uiHidden ? ' off' : ''),
      title: entry.uiHidden
        ? 'On-page UI hidden — the module still runs. Click to show it again.'
        : 'Hide this module’s on-page UI (it keeps running)',
      onclick: () => callbacks.onToggleUi(entry),
    },
    entry.uiHidden ? '🙈' : '👁',
  );
}

/** One button per action for an Action schema (docs/ROADMAP.md #1) — short text labels (not an
 * ambiguous icon; the popup used to get away with a single '▶' when there was only ever one
 * action) — or the single Collection schema "Manage" gear. Empty array when the module has no
 * usable uiSchema (nothing to render). */
function renderActionButtons(entry: RegistryEntry, callbacks: ListViewCallbacks) {
  if (entry.status !== 'ok' || !entry.uiSchema) return [];
  if (entry.uiSchema.kind === 'collection') {
    return [button({ class: 'module-gear', title: 'Manage', onclick: () => callbacks.onOpenModule(entry) }, '⚙')];
  }
  return entry.uiSchema.actions.map((action) =>
    button({ title: action.actionLabel, onclick: () => callbacks.onOpenModule(entry, action.id) }, action.actionLabel),
  );
}

function renderModuleRow(entry: RegistryEntry, callbacks: ListViewCallbacks) {
  // `title` (hover tooltip), not a visible line — this popup is a small fixed-width window, no
  // room for a description under every row like the Dashboard's Management View header can afford.
  // The float-widget note (docs/ROADMAP.md #4.2) is driven by the generic `uiParadigm` field, not
  // hardcoded to network-sniffer by id, so any future float-widget Module gets it for free.
  const tooltipParts = [entry.description, entry.uiParadigm === 'float-widget' ? 'Shows on-page alerts when active.' : null].filter(Boolean);
  const label = span(tooltipParts.length > 0 ? { title: tooltipParts.join(' ') } : {}, entry.label ?? entry.id);
  if (entry.uiSchema) {
    label.classList.add('module-label-link');
    // Collection schema: open Management View. Action schema: default to its first action (e.g.
    // clicking the title still runs the primary action, same as before there could be more than
    // one) — the row's own action buttons below expose every action explicitly.
    label.onclick = () =>
      callbacks.onOpenModule(entry, entry.uiSchema?.kind === 'action' ? entry.uiSchema.actions[0]?.id : undefined);
  }

  // An uploaded module's scopes[] is only known after its first run (see chrome-module-registry.ts) —
  // it can be active with scopes the RPC handler is still rejecting until explicitly granted.
  const ungranted = ungrantedScopes(entry.scopes, entry.grantedScopes);

  // Composite Module (docs/ROADMAP.md #3) — a text button (not another icon; this popup is a small
  // fixed-width window, and "Steps" reads clearer than an ambiguous glyph) opening the Dashboard's
  // per-step toggle view (docs/ROADMAP.md #1's rebuild) — kept independent of the action buttons
  // since a Composite Module can also have its own Action/Collection uiSchema at the same time.
  const stepsBtn =
    entry.status === 'ok' && entry.subModules && entry.subModules.length > 0
      ? button({ title: 'Configure steps', onclick: () => callbacks.onOpenSteps(entry) }, 'Steps')
      : null;

  return li(
    { class: 'module-row' + (entry.status !== 'ok' ? ' disabled' : '') },
    label,
    entry.status !== 'ok' ? span({ class: 'reason', title: entry.reason ?? '' }, 'invalid') : null,
    entry.status === 'ok' && ungranted.length > 0
      ? button({ title: `Requests: ${ungranted.map((g) => g.scope).join(', ')}`, onclick: () => callbacks.onGrant(entry) }, 'Grant')
      : null,
    // Action button(s) + toggle grouped together, visually adjacent, separate from label/reason/grant.
    div(
      { class: 'row-actions' },
      stepsBtn,
      ...renderActionButtons(entry, callbacks),
      ...lifecycleButtons(entry, callbacks),
      uiValveButton(entry, callbacks),
      input({
        type: 'checkbox',
        role: 'switch',
        checked: entry.active,
        disabled: entry.status !== 'ok',
        onchange: () => callbacks.onToggle(entry),
      }),
    ),
  );
}

/** Vòng đời script (docs/ROADMAP.md §12.1) — rename/download/delete, shown for every uploaded
 * script regardless of `status`: an invalid script (bad syntax, rejected shape) is exactly the one
 * a user most wants to rename-to-remember, download-to-fix-elsewhere, or delete. */
function lifecycleButtons(entry: RegistryEntry, callbacks: ListViewCallbacks) {
  if (entry.source !== 'uploaded') return [];
  return [
    button({ class: 'icon-btn', title: 'Rename', onclick: () => callbacks.onRename(entry) }, '✏️'),
    button({ class: 'icon-btn', title: 'Download source', onclick: () => callbacks.onDownload(entry) }, '⬇️'),
    button({ class: 'icon-btn', title: 'Delete', onclick: () => callbacks.onDelete(entry) }, '🗑️'),
  ];
}
