import type { RegistryEntry } from '../../../../kernel/module-registry';

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
  root.innerHTML = '';

  if (props.userScriptsPermissionGranted === false) {
    const banner = document.createElement('div');
    banner.className = 'banner';
    banner.textContent = 'Enable "Allow User Scripts" for this extension in chrome://extensions to run uploaded modules.';
    root.append(banner);
  }

  const header = document.createElement('div');
  header.className = 'header';

  const title = document.createElement('h1');
  title.textContent = 'Synapse Modules';

  const uploadBtn = document.createElement('button');
  uploadBtn.textContent = '⬆';
  uploadBtn.title = 'Upload module';
  uploadBtn.addEventListener('click', callbacks.onUpload);

  const refreshBtn = document.createElement('button');
  refreshBtn.textContent = '⟳';
  refreshBtn.title = 'Refresh';
  refreshBtn.addEventListener('click', callbacks.onRefresh);

  header.append(title, uploadBtn, refreshBtn);
  root.append(header);

  const list = document.createElement('ul');
  list.className = 'module-list';

  for (const entry of entries) {
    list.append(renderModuleRow(entry, callbacks));
  }

  root.append(list);
}

function renderModuleRow(entry: RegistryEntry, callbacks: ListViewCallbacks): HTMLLIElement {
  const row = document.createElement('li');
  row.className = 'module-row';
  if (entry.status !== 'ok') row.classList.add('disabled');

  const label = document.createElement('span');
  label.textContent = entry.label ?? entry.id;
  if (entry.uiSchema) {
    label.classList.add('module-label-link');
    label.addEventListener('click', () => callbacks.onOpenModule(entry));
  }
  row.append(label);

  // Same grey-out + reason treatment for both 'invalid' and 'env-mismatch'.
  if (entry.status !== 'ok') {
    const reason = document.createElement('span');
    reason.className = 'reason';
    reason.title = entry.reason ?? '';
    reason.textContent = entry.status === 'invalid' ? 'invalid' : 'unsupported';
    row.append(reason);
  }

  // An uploaded module's needs[] is only known after its first run (see chrome-module-registry.ts) —
  // it can be active with capabilities the RPC handler is still rejecting until explicitly granted.
  const ungranted = entry.needs.filter((n) => !entry.grantedCapabilities.includes(n));
  if (entry.status === 'ok' && ungranted.length > 0) {
    const grantBtn = document.createElement('button');
    grantBtn.textContent = 'Grant';
    grantBtn.title = `Requests: ${ungranted.join(', ')}`;
    grantBtn.addEventListener('click', () => callbacks.onGrant(entry));
    row.append(grantBtn);
  }

  // Action-icon + toggle grouped together, visually adjacent, separate from label/reason/grant.
  const actions = document.createElement('div');
  actions.className = 'row-actions';

  // Gear/Arrow icon (Navigation Flow, docs/ROADMAP.md #2) — only when the module declares a
  // uiSchema. Its behavior (open Management View vs trigger run()) is decided by router.ts based
  // on the schema's shape, not here. Long-term this action moves to the extension toolbar icon
  // (docs/ROADMAP.md #4) — until then it stays here with a native `title` tooltip.
  if (entry.status === 'ok' && entry.uiSchema) {
    const openBtn = document.createElement('button');
    openBtn.className = 'module-gear';
    openBtn.textContent = entry.uiSchema.kind === 'collection' ? '⚙' : '▶';
    openBtn.title = entry.uiSchema.kind === 'collection' ? 'Manage' : entry.uiSchema.actionLabel;
    openBtn.addEventListener('click', () => callbacks.onOpenModule(entry));
    actions.append(openBtn);
  }

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = entry.active;
  toggle.disabled = entry.status !== 'ok';
  toggle.addEventListener('change', () => callbacks.onToggle(entry));
  actions.append(toggle);

  row.append(actions);

  return row;
}
