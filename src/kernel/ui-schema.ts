/**
 * Declarative UI Schema (docs/ROADMAP.md #2): a Module optionally describes its popup UI shape so
 * the Registry/popup can render generic UI instead of per-module hand-rolled code. Hand-rolled
 * type, no schema library — matches manifest-validator.ts/shared/http-mock.ts house style. The
 * `kind` tag is the shape discriminator (Collection vs on-demand Action) the Navigation Flow uses
 * to decide "open Management View" vs "trigger run() directly" — not a boolean flag.
 */

export type UIFieldType = 'string' | 'number' | 'boolean' | 'enum' | 'file';

export interface UIShowWhenCondition {
  field: string;
  equals: string[];
}

export interface UIFieldDef {
  key: string;
  label: string;
  /** Longer explanation shown as a small hover-only info icon (native `title` tooltip) next to the
   * label, instead of stuffed into `label` itself — keeps the visible label short in both the form
   * and the Management View table header. Rendered by item-form-view.ts/management-view.ts; not
   * meaningful on its own without `label`. */
  hint?: string;
  type: UIFieldType;
  required?: boolean;
  /** Only meaningful when type === 'enum'. */
  options?: string[];
  /** Only meaningful when type === 'string'; renders a <textarea> instead of <input>. */
  multiline?: boolean;
  /** Only meaningful when type === 'number'; enforced as native <input min/max> so the browser
   * rejects an out-of-range value before it ever reaches the Module's own validation. */
  min?: number;
  max?: number;
  /** Only meaningful when type === 'file': renders `<input type="file">`. The submitted *value* is
   * never the file's bytes — item-form-view.ts uploads the chosen file to utils/blob-store.ts as
   * soon as it's picked and submits the resulting blobRef string, same as any other field's value
   * (docs/ROADMAP.md #2.6.1). */
  /** Only meaningful when type === 'file'. Names a companion field (elsewhere in the same
   * `fields` list) holding an inline `{mimeType, fileName, base64}` copy of the same upload — set
   * when a Module needs the bytes available somewhere that can't reach `blob-store.ts` (e.g.
   * http-error-mocker's `mechanism: 'main-world'`, which can't reach IndexedDB). item-form-view.ts
   * combines this field's blobRef with the companion field's current value into one submitted
   * JSON string, so re-saving an existing item without touching the file input doesn't drop
   * whichever half the Module previously stored. */
  fileInlineKey?: string;
  /** Only meaningful when type === 'file'. Names a companion field holding the uploaded file's
   * original name as a plain string (unlike `fileInlineKey`'s full `{mimeType, fileName, base64}`
   * object, this one is small enough to always be present, regardless of any inline-size cap) — so
   * management-view.ts's table can show a readable filename instead of an opaque blobRef, without
   * an IndexedDB lookup per row. item-form-view.ts reads/writes it the same way as `fileInlineKey`. */
  fileNameKey?: string;
  /** Field only rendered (and only submitted) when the named controller field's current live
   * value is one of `equals` — lets one Collection-schema form show different fields depending on
   * another field's selection (e.g. http-error-mocker's action-specific fields, docs/ROADMAP.md
   * #2.6.1). Absent means always visible. The controller field itself is looked up by `key` within
   * the same `fields` list. An array means every condition must hold (AND) — e.g. "action is
   * rewrite-request AND mechanism is main-world or debugger" (http-error-mocker's `rewriteMethod`/
   * `rewriteBody`, which `mechanism: 'dnr'` can't act on at all). */
  showWhen?: UIShowWhenCondition | UIShowWhenCondition[];
  /** Rarely-needed field, grouped into a collapsible "Advanced" `<details>` in the form instead of
   * the main field list (docs/ROADMAP.md #2.6.1) — visibility (`showWhen`) is evaluated the same
   * way either way; this only affects layout. */
  advanced?: boolean;
  /** Only meaningful for a single-line text field (type 'string', not `multiline` — a `<datalist>`
   * pairs with an `<input>`, not a `<textarea>`). Native browser suggestion dropdown: the user can
   * still type anything, but can also pick one of these — `value` is what actually gets submitted,
   * `label` is only what's shown in the dropdown (e.g. a short readable name standing in for a long
   * URL). Doesn't replace `options`/`type: 'enum'`, which forces the value to be one of the list;
   * this is a suggestion, not a constraint. */
  suggestions?: { label: string; value: string }[];
}

export interface UICollectionSchema {
  kind: 'collection';
  itemLabel: string;
  fields: UIFieldDef[];
  /** Defaults to 'id'. */
  idField?: string;
  /** Boolean field rendered as a per-row toggle in the Management View table instead of a plain cell. */
  activeField?: string;
}

export interface UIActionDef {
  /** Passed as `{ action: id }` in `run()`'s input (docs/ROADMAP.md #1's Crawl & Convert Site) —
   * lets one Module expose more than one on-demand action, each dispatched by the Module's own
   * `run()`, not by the Kernel/Registry (which has no notion of "which action"). */
  id: string;
  actionLabel: string;
  /** When 'files', `run()`'s result is `{title, markdown, files: {fileName, mimeType, base64}[]}`
   * instead of the usual free-form result — the popup opens a dedicated full-page Review tab
   * (`ui/review/`) with a ZIP-download action, rather than showing the result inline. For actions
   * producing a downloadable bundle, not just a short text/markdown snippet. */
  resultView?: 'files';
}

/** No persisted collection — clicking one of the module's action buttons triggers run() directly
 * with `{ action: id }` as input. */
export interface UIActionSchema {
  kind: 'action';
  actions: UIActionDef[];
}

export type UISchema = UICollectionSchema | UIActionSchema;

export function isCollectionSchema(schema: UISchema): schema is UICollectionSchema {
  return schema.kind === 'collection';
}

/** Normalizes `UIFieldDef.showWhen` (single condition, array of conditions, or absent) into a
 * plain array — the one place that has to know about the single-vs-array shorthand, so
 * item-form-view.ts's visibility/controller-tracking logic doesn't have to branch on it itself. */
export function showWhenConditions(showWhen: UIFieldDef['showWhen']): UIShowWhenCondition[] {
  if (!showWhen) return [];
  return Array.isArray(showWhen) ? showWhen : [showWhen];
}

/** Generic wire shape for a Bus command targeting any collection-schema Module — one shape
 * reusable across modules instead of each hand-rolling its own {op, ...} command type. */
export type CollectionCommand<T = unknown> =
  | { op: 'upsert'; item: T }
  | { op: 'delete'; id: string }
  | { op: 'sync' };
