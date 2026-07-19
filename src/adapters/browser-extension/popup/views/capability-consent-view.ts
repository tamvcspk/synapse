/** In-flow capability-consent view, replacing the native <dialog> version — see
 * action-result-view.ts's header comment for why this popup never uses <dialog>. */
export interface CapabilityConsentViewProps {
  moduleId: string;
  capabilities: string[];
}

export interface CapabilityConsentViewCallbacks {
  onApprove(): void;
  onDeny(): void;
}

export function renderCapabilityConsentView(
  root: HTMLElement,
  props: CapabilityConsentViewProps,
  callbacks: CapabilityConsentViewCallbacks,
): void {
  root.innerHTML = '';

  const container = document.createElement('div');
  container.className = 'item-form';

  const message = document.createElement('p');
  message.textContent = `"${props.moduleId}" requests access to:`;

  const list = document.createElement('ul');
  for (const capability of props.capabilities) {
    const item = document.createElement('li');
    item.textContent = capability;
    list.append(item);
  }

  const menu = document.createElement('menu');

  const denyBtn = document.createElement('button');
  denyBtn.type = 'button';
  denyBtn.textContent = 'Deny';
  denyBtn.addEventListener('click', callbacks.onDeny);

  const approveBtn = document.createElement('button');
  approveBtn.type = 'button';
  approveBtn.textContent = 'Allow';
  approveBtn.addEventListener('click', callbacks.onApprove);

  menu.append(denyBtn, approveBtn);
  container.append(message, list, menu);
  root.append(container);
}
