import van from 'vanjs-core';

const { div, p, ul, li, button } = van.tags;

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
  root.replaceChildren();

  van.add(
    root,
    div(
      p(`"${props.moduleId}" requests access to:`),
      ul(...props.capabilities.map((capability) => li(capability))),
      div(
        { class: 'form-actions' },
        button({ type: 'button', class: 'secondary', onclick: callbacks.onDeny }, 'Deny'),
        button({ type: 'button', onclick: callbacks.onApprove }, 'Allow'),
      ),
    ),
  );
}
