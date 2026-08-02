import van from 'vanjs-core';

const { div, p, input, button, strong } = van.tags;

/**
 * In-flow rename view (docs/ROADMAP.md §12.1) — same "never a native <dialog>" reasoning as
 * action-result-view.ts's header comment. A dedicated view rather than an inline `<input>` swapped
 * into the row: this popup's list re-renders from scratch on every state change (no persistent
 * VanJS binding across renders — see router.ts's own doc comment), so an in-row edit would need its
 * own local state machine bolted onto `renderListView` for a one-off case.
 */
export interface RenameViewProps {
  currentLabel: string;
}

export interface RenameViewCallbacks {
  onSave(label: string): void;
  onCancel(): void;
}

export function renderRenameView(root: HTMLElement, props: RenameViewProps, callbacks: RenameViewCallbacks): void {
  root.replaceChildren();

  const field = input({ type: 'text', value: props.currentLabel });

  const submit = () => {
    const label = field.value.trim();
    if (label.length > 0) callbacks.onSave(label);
  };
  field.onkeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') callbacks.onCancel();
  };

  van.add(
    root,
    div(
      p(strong('Rename script')),
      field,
      div(
        { class: 'form-actions' },
        button({ type: 'button', class: 'secondary', onclick: callbacks.onCancel }, 'Cancel'),
        button({ type: 'button', onclick: submit }, 'Save'),
      ),
    ),
  );

  field.focus();
  field.select();
}
