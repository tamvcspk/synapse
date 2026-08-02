import van from 'vanjs-core';
import { showWhenConditions, type UICollectionSchema, type UIFieldDef } from '../../../../../kernel/ui-schema';
import { bytesToBase64, putBlob } from '../../../utils/blob-store';
import { icon, ICONS } from '../../icon';

const { div, form, label, input, select, option, textarea, button, h2, details, summary, small, span, datalist } = van.tags;

/** Above this raw file size, skip the inline `{mimeType, fileName, base64}` copy entirely (still
 * upload to IndexedDB via blob-store.ts, unaffected by this cap) — chrome.storage.local's ~5MB
 * quota is shared by the *entire* extension, not just one rule's file, so inlining an uncapped file
 * risks starving everything else synced through it (docs/ROADMAP.md #2.6.1). Only affects
 * `mechanism: 'main-world'`, which has no other way to get bytes into its MAIN-world payload. */
const MAX_INLINE_FILE_BYTES = 2 * 1024 * 1024;

/** In-flow add/edit form generated from a UICollectionSchema — the Dashboard-page counterpart of
 * the popup's now-removed item-form-view.ts (docs/ROADMAP.md #2.5), VanJS instead of hand-rolled
 * DOM. Navigates back to the Management View on both Save and Cancel; the caller (dashboard's
 * main.ts) owns that navigation via the callbacks. */
export interface ItemFormViewCallbacks {
  /** Returns a Promise now (docs/ROADMAP.md §11.5) — a rejection (e.g. the Module's own
   * validateMockConfig-style check throwing) is caught here and shown inline instead of the form
   * silently navigating back to the list either way, which is what happened when this write path
   * was fire-and-forget (see module-data-sources.ts's `emitCollectionCommand`). The caller (the
   * Dashboard's main.ts) is still the one that decides to navigate on SUCCESS — this file only
   * ever reacts to a rejection. */
  onSave(item: Record<string, unknown>): Promise<void>;
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
  const fieldEntries = new Map<
    string,
    { fieldLabel: HTMLLabelElement; fieldInput: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement }
  >();

  // Any field named by another field's `showWhen` condition(s) is a "controller" (docs/ROADMAP.md
  // #2.6.1's mechanism-then-action flow) — its *live* value, not just its value at submit time,
  // decides which other fields are currently visible, so it needs a van.state a reactive container
  // can depend on. Same technique management-view.ts's `filter` state already uses.
  const controllerKeys = new Set(formFields.flatMap((f) => showWhenConditions(f.showWhen).map((c) => c.field)));
  const controllerStates = new Map<string, ReturnType<typeof van.state<string>>>();
  for (const key of controllerKeys) {
    const controllerField = formFields.find((f) => f.key === key);
    controllerStates.set(key, van.state(initialFieldValue(controllerField, existing)));
  }

  // Every condition must hold (AND) — e.g. http-error-mocker's rewriteMethod/rewriteBody need
  // action: rewrite-request AND mechanism: main-world|debugger (mechanism: 'dnr' can't act on
  // either at all, see shared/http-mock.ts's validateMockConfig).
  function isVisible(field: UIFieldDef): boolean {
    return showWhenConditions(field.showWhen).every((condition) => {
      const controllerState = controllerStates.get(condition.field);
      return controllerState ? condition.equals.includes(controllerState.val) : true;
    });
  }

  function visibleFields(): UIFieldDef[] {
    return formFields.filter(isVisible);
  }

  // A file field's upload happens as soon as it's picked (see renderField's 'file' branch), not
  // at Save time — but it's still async, so Save must be disabled while one is in flight, or a
  // fast click could submit the field's *previous* blobRef (or none) instead of the new upload's.
  // Declared before `saveButton` exists (assigned once the button is created below) — safe because
  // `setUploading` is only ever invoked later, from a file input's async 'change' handler.
  //
  // Reused below for the Save click itself (now also async — see `ItemFormViewCallbacks.onSave`'s
  // doc comment) for the exact same reason: without disabling the button, a second click while the
  // first save is still in flight could fire a duplicate onSave before the first one's result (a
  // navigate-away on success, or an error to show) has landed.
  let saveButton!: HTMLButtonElement;
  let pendingUploads = 0;
  const setUploading = (uploading: boolean) => {
    pendingUploads += uploading ? 1 : -1;
    saveButton.disabled = pendingUploads > 0;
  };

  // Shown when callbacks.onSave() rejects (e.g. the Module's own validation threw) — hidden by
  // default and on every new save attempt, so a stale error from a previous try doesn't linger
  // once the user has changed something and is trying again.
  const errorBanner = div({ class: 'form-error', style: 'display:none' });

  for (const field of formFields) {
    const { fieldLabel, fieldInput } = renderField(field, existing, setUploading);
    fieldEntries.set(field.key, { fieldLabel, fieldInput });

    const controllerState = controllerStates.get(field.key);
    if (controllerState) {
      // A controller field is always visible itself, so this only ever fires for a live user
      // selection — keeps `isVisible` (and thus the reactive container below) in sync with it.
      fieldInput.addEventListener('change', () => {
        controllerState.val = (fieldInput as HTMLSelectElement).value;
      });
    }
  }

  // Function child: VanJS re-invokes this whenever a controller state read inside changes,
  // rebuilding just the visible-field wrapper instead of the whole form. The *same* fieldLabel DOM
  // node instances are reused across recomputes (via `fieldEntries`, built once above) — van moves
  // rather than recreates them, so a field re-appearing after being hidden keeps whatever the user
  // had already typed into it, and a hidden field's `required` constraint is skipped for free (an
  // element not currently inside the <form>'s DOM subtree isn't part of its validation set).
  //
  // Visible fields are further split into the main list and a collapsible "Advanced" `<details>`
  // (docs/ROADMAP.md #2.6.1) for rarely-needed ones (field.advanced) — layout only, doesn't affect
  // which fields are considered visible/submitted. The `<details>` itself is omitted entirely when
  // no advanced field is currently visible (e.g. action: 'block' has none), rather than rendering
  // an empty collapsible.
  const fieldsSlot = div(() => {
    const visible = visibleFields();
    const normalFields = visible.filter((f) => !f.advanced);
    const advancedFields = visible.filter((f) => f.advanced);
    return div(
      ...normalFields.map((f) => fieldEntries.get(f.key)!.fieldLabel),
      ...(advancedFields.length > 0
        ? [details(summary('Advanced'), ...advancedFields.map((f) => fieldEntries.get(f.key)!.fieldLabel))]
        : []),
    );
  });

  // type: 'submit' + reportValidity() gets us native required/min/max checking (a plain onclick
  // button never triggers constraint validation, which is how an empty Fake status used to
  // silently become 0 and get rejected with zero UI feedback). But we still own the actual save —
  // preventDefault() first so the browser never attempts its own submission afterward; without it,
  // a *successful* save's navigate() call (still owned by the caller — see onSave's doc comment)
  // would replace the view (root.replaceChildren()) before the browser gets to its default action,
  // and it warns "Form submission canceled because the form is not connected" trying to submit a
  // form that's no longer in the document.
  saveButton = button(
    {
      type: 'submit',
      onclick: (e: Event) => {
        e.preventDefault();
        const target = e.currentTarget as HTMLButtonElement;
        if (!target.form!.reportValidity()) return;

        const item: Record<string, unknown> = { ...existing };
        item[idField] = existing?.[idField] ?? crypto.randomUUID();
        if (schema.activeField) item[schema.activeField] = existing?.[schema.activeField] ?? true;
        // Only the fields currently visible get (re-)submitted — a field hidden by the live
        // mechanism/action selection is irrelevant to the chosen combination and shouldn't be
        // written from a stale <input> the user never got to see, let alone edit.
        for (const field of visibleFields()) {
          const fieldInput = fieldEntries.get(field.key)!.fieldInput;
          item[field.key] = readFieldValue(field, fieldInput);
        }

        errorBanner.textContent = '';
        errorBanner.style.display = 'none';
        setUploading(true);
        callbacks
          .onSave(item)
          .catch((err: unknown) => {
            // Stays on the form (caller's onSave only navigates after its own await succeeds — see
            // its doc comment) so the user's input isn't lost and they can fix the rejected field.
            errorBanner.textContent = err instanceof Error ? err.message : String(err);
            errorBanner.style.display = 'block';
          })
          .finally(() => setUploading(false));
      },
    },
    existing ? 'Save' : 'Add',
  );

  const formEl = form(
    fieldsSlot,
    errorBanner,
    div(
      { class: 'form-actions' },
      button({ type: 'button', class: 'secondary', onclick: callbacks.onCancel }, 'Cancel'),
      saveButton,
    ),
  );

  van.add(root, h2(`${existing ? 'Edit' : 'Add'} ${schema.itemLabel}`), formEl);
}

/** Seeds a controller field's initial `van.state` so it matches what `renderField`'s enum branch
 * actually renders as pre-selected (existing value, or the first `option` when there's none —
 * `<select>` without a marked `selected` option defaults to its first entry natively). */
function initialFieldValue(field: UIFieldDef | undefined, existing?: Record<string, unknown>): string {
  if (!field) return '';
  const existingValue = existing?.[field.key];
  if (existingValue !== undefined) return String(existingValue);
  return field.options?.[0] ?? '';
}

/** A field's longer explanation (`field.hint`) renders as a small hover-only info icon next to the
 * label instead of being stuffed into the visible label text — the native `title` attribute gives
 * a tooltip on hover with zero extra markup/JS. Absent when there's no hint to show. */
function infoIcon(hint: string): HTMLElement {
  return span({ title: hint, style: 'cursor:help;opacity:0.6;margin-left:0.25em' }, icon(ICONS.info));
}

function renderField(
  field: UIFieldDef,
  existing?: Record<string, unknown>,
  onUploadStateChange?: (uploading: boolean) => void,
): { fieldLabel: HTMLLabelElement; fieldInput: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement } {
  const existingValue = existing?.[field.key];
  const labelSuffix = field.hint ? [infoIcon(field.hint)] : [];

  if (field.type === 'boolean') {
    const fieldInput = input({ type: 'checkbox', checked: Boolean(existingValue) });
    const fieldLabel = label(fieldInput, ` ${field.label}`, ...labelSuffix);
    return { fieldLabel, fieldInput };
  }

  if (field.type === 'file') {
    const fieldInput = input({ type: 'file' });
    // Shows the uploaded file's *name*, not the blobRef — a raw UUID means nothing to a user
    // looking at this form. Doubles as the size-limit warning when relevant (see 'change' below).
    const status = small({ style: 'display:block' });

    // The submitted value (see readFieldValue) is never the file's bytes — it's a JSON string
    // combining a blob-store.ts blobRef, the original fileName (field.fileNameKey's companion
    // field), and an optional inline `{mimeType, fileName, base64}` copy (field.fileInlineKey's
    // companion field) — stashed on `dataset` since a file input's .value can't be set to an
    // arbitrary string. Reconstructed from `existing` here so re-saving an item WITHOUT touching
    // the file input keeps whichever half(s) it already had, rather than silently dropping them.
    const existingBlobRef = existingValue !== undefined ? String(existingValue) : undefined;
    const existingFileName = field.fileNameKey ? existing?.[field.fileNameKey] : undefined;
    const existingInline = field.fileInlineKey ? existing?.[field.fileInlineKey] : undefined;
    fieldInput.dataset.fileValue = JSON.stringify({
      ...(existingBlobRef ? { blobRef: existingBlobRef } : {}),
      ...(existingFileName ? { fileName: existingFileName } : {}),
      ...(existingInline ? { inline: existingInline } : {}),
    });
    if (typeof existingFileName === 'string' && existingFileName) status.textContent = `Current file: ${existingFileName}`;

    // Upload happens immediately on 'change', not at Save time, since Save's own handler is
    // synchronous (see the file-level comment on `setUploading`).
    fieldInput.addEventListener('change', () => {
      const file = fieldInput.files?.[0];
      if (!file) return;
      onUploadStateChange?.(true);
      void (async () => {
        try {
          const bytes = await file.arrayBuffer();
          const mimeType = file.type || 'application/octet-stream';
          const blobRef = crypto.randomUUID();
          await putBlob(blobRef, { mimeType, fileName: file.name, bytes });

          if (file.size <= MAX_INLINE_FILE_BYTES) {
            const inline = { mimeType, fileName: file.name, base64: bytesToBase64(bytes) };
            fieldInput.dataset.fileValue = JSON.stringify({ blobRef, fileName: file.name, inline });
            status.textContent = file.name;
          } else {
            fieldInput.dataset.fileValue = JSON.stringify({ blobRef, fileName: file.name });
            status.textContent = `${file.name} — ${(file.size / (1024 * 1024)).toFixed(1)}MB, over the 2MB inline limit, so this file only works with mechanism: debugger, not main-world.`;
          }
        } finally {
          onUploadStateChange?.(false);
        }
      })();
    });
    const fieldLabel = label(field.label, ...labelSuffix, fieldInput, status);
    return { fieldLabel, fieldInput };
  }

  if (field.type === 'enum') {
    const fieldInput = select(
      { required: Boolean(field.required) },
      ...(field.options ?? []).map((opt) => option({ value: opt, selected: existingValue === opt }, opt)),
    );
    const fieldLabel = label(field.label, ...labelSuffix, fieldInput);
    return { fieldLabel, fieldInput };
  }

  const stringValue = existingValue === undefined ? '' : String(existingValue);

  if (field.type === 'string' && field.multiline) {
    const fieldInput = textarea({ rows: 3, required: Boolean(field.required) }, stringValue);
    const fieldLabel = label(field.label, ...labelSuffix, fieldInput);
    return { fieldLabel, fieldInput };
  }

  // Native suggestion dropdown (still lets the user type any value) — <datalist> only pairs with a
  // single-line <input>, so only offered for type: 'string' here (never 'number', which reaches
  // this same branch too).
  const datalistId = field.type === 'string' && field.suggestions?.length ? `datalist-${field.key}` : undefined;
  const suggestionsList = datalistId
    ? datalist({ id: datalistId }, ...field.suggestions!.map((s) => option({ value: s.value }, s.label)))
    : null;

  const fieldInput = input({
    type: field.type === 'number' ? 'number' : 'text',
    required: Boolean(field.required),
    value: stringValue,
    ...(datalistId ? { list: datalistId } : {}),
    ...(field.type === 'number' && field.min !== undefined ? { min: field.min } : {}),
    ...(field.type === 'number' && field.max !== undefined ? { max: field.max } : {}),
  });
  const fieldLabel = label(field.label, ...labelSuffix, fieldInput, suggestionsList);
  return { fieldLabel, fieldInput };
}

function readFieldValue(field: UIFieldDef, fieldInput: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): unknown {
  if (field.type === 'boolean') return (fieldInput as HTMLInputElement).checked;
  if (field.type === 'number') {
    // Blank must mean "unset", not 0 — a `required` field can never reach here blank (the
    // reportValidity() check above already rejects that before onSave runs), but an *optional*
    // number field (e.g. hitCountLimit, min: 1) left empty would otherwise submit as 0 and fail
    // its own min-value validation for having "set" a value that was never actually entered.
    return fieldInput.value === '' ? undefined : Number(fieldInput.value);
  }
  if (field.type === 'file') return (fieldInput as HTMLInputElement).dataset.fileValue || undefined;
  return fieldInput.value;
}
