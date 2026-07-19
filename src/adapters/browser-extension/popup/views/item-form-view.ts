import type { UICollectionSchema, UIFieldDef } from '../../../../kernel/ui-schema';

/** In-flow add/edit form generated from a UICollectionSchema, replacing the native <dialog>
 * version — see action-result-view.ts's header comment for why this popup never uses <dialog>.
 * Navigates back to Management View on both Save and Cancel (docs/ROADMAP.md #2 flow: "navigate
 * to a form, don't pop up") — the caller (router.ts) owns that navigation via the callbacks. */
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
  root.innerHTML = '';

  const idField = schema.idField ?? 'id';
  const formFields = schema.fields.filter((f) => f.key !== idField && f.key !== schema.activeField);

  const container = document.createElement('div');
  container.className = 'item-form';

  const title = document.createElement('p');
  title.textContent = `${existing ? 'Edit' : 'Add'} ${schema.itemLabel}`;
  container.append(title);

  const fieldInputs = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
  for (const field of formFields) {
    const { label, input } = renderField(field, existing);
    fieldInputs.set(field.key, input);
    container.append(label);
  }

  const menu = document.createElement('menu');

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', callbacks.onCancel);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = existing ? 'Save' : 'Add';
  saveBtn.addEventListener('click', () => {
    const item: Record<string, unknown> = { ...existing };
    item[idField] = existing?.[idField] ?? crypto.randomUUID();
    if (schema.activeField) item[schema.activeField] = existing?.[schema.activeField] ?? true;
    for (const field of formFields) {
      const input = fieldInputs.get(field.key)!;
      item[field.key] = readFieldValue(field, input);
    }
    callbacks.onSave(item);
  });

  menu.append(cancelBtn, saveBtn);
  container.append(menu);
  root.append(container);
}

function renderField(
  field: UIFieldDef,
  existing?: Record<string, unknown>,
): { label: HTMLLabelElement; input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement } {
  const existingValue = existing?.[field.key];
  const label = document.createElement('label');

  if (field.type === 'boolean') {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(existingValue);
    label.append(input, document.createTextNode(` ${field.label}`));
    return { label, input };
  }

  if (field.type === 'enum') {
    label.append(document.createTextNode(field.label));
    const select = document.createElement('select');
    if (field.required) select.required = true;
    for (const option of field.options ?? []) {
      const optionEl = document.createElement('option');
      optionEl.value = option;
      optionEl.textContent = option;
      optionEl.selected = existingValue === option;
      select.append(optionEl);
    }
    label.append(select);
    return { label, input: select };
  }

  label.append(document.createTextNode(field.label));
  const stringValue = existingValue === undefined ? '' : String(existingValue);

  if (field.type === 'string' && field.multiline) {
    const textarea = document.createElement('textarea');
    textarea.rows = 3;
    if (field.required) textarea.required = true;
    textarea.value = stringValue;
    label.append(textarea);
    return { label, input: textarea };
  }

  const input = document.createElement('input');
  input.type = field.type === 'number' ? 'number' : 'text';
  if (field.required) input.required = true;
  input.value = stringValue;
  label.append(input);
  return { label, input };
}

function readFieldValue(field: UIFieldDef, input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): unknown {
  if (field.type === 'boolean') return (input as HTMLInputElement).checked;
  if (field.type === 'number') return Number(input.value || 0);
  return input.value;
}
