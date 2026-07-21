import van from 'vanjs-core';
import type { UICollectionSchema, UIFieldDef } from '../../../../../kernel/ui-schema';

const { div, form, label, input, select, option, textarea, button, h2 } = van.tags;

/** In-flow add/edit form generated from a UICollectionSchema — the Dashboard-page counterpart of
 * the popup's now-removed item-form-view.ts (docs/ROADMAP.md #2.5), VanJS instead of hand-rolled
 * DOM. Navigates back to the Management View on both Save and Cancel; the caller (dashboard's
 * main.ts) owns that navigation via the callbacks. */
export interface ItemFormViewCallbacks {
  onSave(item: Record<string, unknown>): void;
  onCancel(): void;
}

export function renderItemFormView(
  root: HTMLElement,
  schema: UICollectionSchema,
  existing: Record<string, unknown> | undefined,
  callbacks: ItemFormViewCallbacks,
): void {
  root.replaceChildren();

  const idField = schema.idField ?? 'id';
  const formFields = schema.fields.filter((f) => f.key !== idField && f.key !== schema.activeField);
  const fieldInputs = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();

  // type: 'submit' + reportValidity() gets us native required/min/max checking (a plain onclick
  // button never triggers constraint validation, which is how an empty Fake status used to
  // silently become 0 and get rejected with zero UI feedback). But we still own the actual save —
  // preventDefault() first so the browser never attempts its own submission afterward; without it,
  // onSave()'s navigate() call replaces the view (root.replaceChildren()) before the browser gets
  // to its default action, and it warns "Form submission canceled because the form is not
  // connected" trying to submit a form that's no longer in the document.
  const formEl = form(
    ...formFields.map((field) => {
      const { fieldLabel, fieldInput } = renderField(field, existing);
      fieldInputs.set(field.key, fieldInput);
      return fieldLabel;
    }),
    div(
      { class: 'form-actions' },
      button({ type: 'button', class: 'secondary', onclick: callbacks.onCancel }, 'Cancel'),
      button(
        {
          type: 'submit',
          onclick: (e: Event) => {
            e.preventDefault();
            const target = e.currentTarget as HTMLButtonElement;
            if (!target.form!.reportValidity()) return;

            const item: Record<string, unknown> = { ...existing };
            item[idField] = existing?.[idField] ?? crypto.randomUUID();
            if (schema.activeField) item[schema.activeField] = existing?.[schema.activeField] ?? true;
            for (const field of formFields) {
              const fieldInput = fieldInputs.get(field.key)!;
              item[field.key] = readFieldValue(field, fieldInput);
            }
            callbacks.onSave(item);
          },
        },
        existing ? 'Save' : 'Add',
      ),
    ),
  );

  van.add(root, h2(`${existing ? 'Edit' : 'Add'} ${schema.itemLabel}`), formEl);
}

function renderField(
  field: UIFieldDef,
  existing?: Record<string, unknown>,
): { fieldLabel: HTMLLabelElement; fieldInput: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement } {
  const existingValue = existing?.[field.key];

  if (field.type === 'boolean') {
    const fieldInput = input({ type: 'checkbox', checked: Boolean(existingValue) });
    const fieldLabel = label(fieldInput, ` ${field.label}`);
    return { fieldLabel, fieldInput };
  }

  if (field.type === 'enum') {
    const fieldInput = select(
      { required: Boolean(field.required) },
      ...(field.options ?? []).map((opt) => option({ value: opt, selected: existingValue === opt }, opt)),
    );
    const fieldLabel = label(field.label, fieldInput);
    return { fieldLabel, fieldInput };
  }

  const stringValue = existingValue === undefined ? '' : String(existingValue);

  if (field.type === 'string' && field.multiline) {
    const fieldInput = textarea({ rows: 3, required: Boolean(field.required) }, stringValue);
    const fieldLabel = label(field.label, fieldInput);
    return { fieldLabel, fieldInput };
  }

  const fieldInput = input({
    type: field.type === 'number' ? 'number' : 'text',
    required: Boolean(field.required),
    value: stringValue,
    ...(field.type === 'number' && field.min !== undefined ? { min: field.min } : {}),
    ...(field.type === 'number' && field.max !== undefined ? { max: field.max } : {}),
  });
  const fieldLabel = label(field.label, fieldInput);
  return { fieldLabel, fieldInput };
}

function readFieldValue(field: UIFieldDef, fieldInput: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): unknown {
  if (field.type === 'boolean') return (fieldInput as HTMLInputElement).checked;
  if (field.type === 'number') return Number(fieldInput.value || 0);
  return fieldInput.value;
}
