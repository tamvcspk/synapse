/**
 * Declarative UI Schema (docs/ROADMAP.md #2): a Module optionally describes its popup UI shape so
 * the Registry/popup can render generic UI instead of per-module hand-rolled code. Hand-rolled
 * type, no schema library — matches manifest-validator.ts/shared/http-mock.ts house style. The
 * `kind` tag is the shape discriminator (Collection vs on-demand Action) the Navigation Flow uses
 * to decide "open Management View" vs "trigger run() directly" — not a boolean flag.
 */

export type UIFieldType = 'string' | 'number' | 'boolean' | 'enum';

export interface UIFieldDef {
  key: string;
  label: string;
  type: UIFieldType;
  required?: boolean;
  /** Only meaningful when type === 'enum'. */
  options?: string[];
  /** Only meaningful when type === 'string'; renders a <textarea> instead of <input>. */
  multiline?: boolean;
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

/** No persisted collection — clicking the module's icon triggers run() directly. */
export interface UIActionSchema {
  kind: 'action';
  actionLabel: string;
}

export type UISchema = UICollectionSchema | UIActionSchema;

export function isCollectionSchema(schema: UISchema): schema is UICollectionSchema {
  return schema.kind === 'collection';
}

/** Generic wire shape for a Bus command targeting any collection-schema Module — one shape
 * reusable across modules instead of each hand-rolling its own {op, ...} command type. */
export type CollectionCommand<T = unknown> =
  | { op: 'upsert'; item: T }
  | { op: 'delete'; id: string }
  | { op: 'sync' };
