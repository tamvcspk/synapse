import van from 'vanjs-core';
import type { RegistryEntry } from '../../../../../kernel/module-registry';

const { div, nav, ul, li, strong, button, span, input } = van.tags;

export interface ListViewCallbacks {
  onToggle(entry: RegistryEntry): void;
  onGrant(entry: RegistryEntry): void;
  onUpload(): void;
  onRefresh(): void;
  /** Navigation Flow (docs/ROADMAP.md #2): row/icon click for any entry carrying a uiSchema —
   * router.ts decides whether that means "open Management View" or "trigger run() directly". */
  onOpenModule(entry: RegistryEntry): void;
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
        li(button({ title: 'Upload module', onclick: callbacks.onUpload }, '⬆')),
        li(button({ title: 'Refresh', onclick: callbacks.onRefresh }, '⟳')),
      ),
    ),
    ul({ class: 'module-list' }, ...entries.map((entry) => renderModuleRow(entry, callbacks))),
  );
}

function renderModuleRow(entry: RegistryEntry, callbacks: ListViewCallbacks) {
  // `title` (hover tooltip), not a visible line — this popup is a small fixed-width window, no
  // room for a description under every row like the Dashboard's Management View header can afford.
  const label = span(entry.description ? { title: entry.description } : {}, entry.label ?? entry.id);
  if (entry.uiSchema) {
    label.classList.add('module-label-link');
    label.onclick = () => callbacks.onOpenModule(entry);
  }

  // An uploaded module's needs[] is only known after its first run (see chrome-module-registry.ts) —
  // it can be active with capabilities the RPC handler is still rejecting until explicitly granted.
  const ungranted = entry.needs.filter((n) => !entry.grantedCapabilities.includes(n));

  // Gear/Arrow icon (Navigation Flow, docs/ROADMAP.md #2) — only when the module declares a
  // uiSchema. Its behavior (open Management View vs trigger run()) is decided by router.ts based
  // on the schema's shape, not here. Long-term this action moves to the extension toolbar icon
  // (docs/ROADMAP.md #4) — until then it stays here with a native `title` tooltip.
  const gearBtn =
    entry.status === 'ok' && entry.uiSchema
      ? button(
          {
            class: 'module-gear',
            title: entry.uiSchema.kind === 'collection' ? 'Manage' : entry.uiSchema.actionLabel,
            onclick: () => callbacks.onOpenModule(entry),
          },
          entry.uiSchema.kind === 'collection' ? '⚙' : '▶',
        )
      : null;

  return li(
    { class: 'module-row' + (entry.status !== 'ok' ? ' disabled' : '') },
    label,
    // Same grey-out + reason treatment for both 'invalid' and 'env-mismatch'.
    entry.status !== 'ok'
      ? span({ class: 'reason', title: entry.reason ?? '' }, entry.status === 'invalid' ? 'invalid' : 'unsupported')
      : null,
    entry.status === 'ok' && ungranted.length > 0
      ? button({ title: `Requests: ${ungranted.join(', ')}`, onclick: () => callbacks.onGrant(entry) }, 'Grant')
      : null,
    // Action-icon + toggle grouped together, visually adjacent, separate from label/reason/grant.
    div(
      { class: 'row-actions' },
      gearBtn,
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
