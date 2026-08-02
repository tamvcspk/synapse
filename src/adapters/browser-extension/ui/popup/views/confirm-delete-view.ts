import van from 'vanjs-core';

const { div, p, strong, button } = van.tags;

/**
 * In-flow confirm view for deleting an uploaded script (docs/ROADMAP.md §12.1) — a dedicated view,
 * not `window.confirm()`: a blocking native dialog inside a Chrome MV3 popup is unreliable (the
 * popup can lose focus and close under it), the same reasoning that already rules out `<dialog>`
 * (see action-result-view.ts). Deletion removes the script's grant/registration/storage entirely
 * (see chrome-module-registry.ts's `deleteScript`) — worth one extra click before it happens.
 */
export interface ConfirmDeleteViewProps {
  label: string;
}

export interface ConfirmDeleteViewCallbacks {
  onConfirm(): void;
  onCancel(): void;
}

export function renderConfirmDeleteView(
  root: HTMLElement,
  props: ConfirmDeleteViewProps,
  callbacks: ConfirmDeleteViewCallbacks,
): void {
  root.replaceChildren();

  van.add(
    root,
    div(
      p('Delete ', strong(props.label), '? This removes its permissions and stored data — the source is gone unless you downloaded it first.'),
      div(
        { class: 'form-actions' },
        button({ type: 'button', class: 'secondary', onclick: callbacks.onCancel }, 'Cancel'),
        button({ type: 'button', class: 'delete-confirm', onclick: callbacks.onConfirm }, 'Delete'),
      ),
    ),
  );
}
