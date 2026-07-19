import type { RegistryEntry } from '../../../kernel/module-registry';

export interface RenderCallbacks {
  onToggle(entry: RegistryEntry): void;
  onGrant(entry: RegistryEntry): void;
  onUpload(): void;
  onRefresh(): void;
}

export interface RenderOptions {
  /** false when chrome.userScripts.configureWorld failed — see background/index.ts + storage.ts. */
  userScriptsPermissionGranted?: boolean;
}

/** Single list view — no separate settings screen/navigation by design. */
export function renderPopup(
  root: HTMLElement,
  entries: RegistryEntry[],
  callbacks: RenderCallbacks,
  options: RenderOptions = {},
): void {
  root.innerHTML = '';

  if (options.userScriptsPermissionGranted === false) {
    const banner = document.createElement('div');
    banner.className = 'banner';
    banner.textContent = 'Enable "Allow User Scripts" for this extension in chrome://extensions to run uploaded modules.';
    root.append(banner);
  }

  const header = document.createElement('div');
  header.className = 'header';

  const title = document.createElement('h1');
  title.textContent = 'Synapse Modules';

  const refreshBtn = document.createElement('button');
  refreshBtn.textContent = '⟳';
  refreshBtn.title = 'Refresh';
  refreshBtn.addEventListener('click', callbacks.onRefresh);

  header.append(title, refreshBtn);
  root.append(header);

  const list = document.createElement('ul');
  list.className = 'module-list';

  for (const entry of entries) {
    list.append(renderModuleRow(entry, callbacks));
  }

  const uploadRow = document.createElement('li');
  uploadRow.className = 'module-row upload-row';
  const uploadBtn = document.createElement('button');
  uploadBtn.textContent = 'Upload module';
  uploadBtn.addEventListener('click', callbacks.onUpload);
  uploadRow.append(uploadBtn);
  list.append(uploadRow);

  root.append(list);
}

function renderModuleRow(entry: RegistryEntry, callbacks: RenderCallbacks): HTMLLIElement {
  const row = document.createElement('li');
  row.className = 'module-row';
  if (entry.status !== 'ok') row.classList.add('disabled');

  const label = document.createElement('span');
  label.textContent = entry.label ?? entry.id;
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

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = entry.active;
  toggle.disabled = entry.status !== 'ok';
  toggle.addEventListener('change', () => callbacks.onToggle(entry));
  row.append(toggle);

  return row;
}
