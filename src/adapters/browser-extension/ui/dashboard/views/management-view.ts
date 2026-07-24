import van from 'vanjs-core';
import type { RegistryEntry } from '../../../../../kernel/module-registry';
import type { UICollectionSchema } from '../../../../../kernel/ui-schema';

const { div, h1, button, input, table, thead, tbody, tr, th, td, p, header, section } = van.tags;

export interface ManagementViewCallbacks {
  onAdd(): void;
  onEdit(item: Record<string, unknown>): void;
  onToggleActive?(item: Record<string, unknown>): void;
  onDelete(item: Record<string, unknown>): void;
}

/**
 * Generic CRUD renderer driven entirely by a UICollectionSchema (docs/ROADMAP.md #2, extended by
 * #2.5) — the Dashboard-page counterpart of the popup's now-removed management-view.ts, same
 * schema, VanJS instead of hand-rolled createElement/innerHTML per #2.5's decision. Only ever sees
 * Record<string, unknown> items, never a module-specific type like MockConfig.
 */
export function renderManagementView(
  root: HTMLElement,
  entry: RegistryEntry,
  schema: UICollectionSchema,
  items: Record<string, unknown>[],
  callbacks: ManagementViewCallbacks,
): void {
  root.replaceChildren();

  const idField = schema.idField ?? 'id';
  // Advanced fields (docs/ROADMAP.md #2.6.1) are rarely-needed by definition — showing them as
  // columns here would make an already-wide table (many fields are only relevant to one specific
  // action/mechanism combo) worse for no real benefit, since they're still fully editable via the
  // item form. Filtering (below) only searches what's actually displayed, for the same reason.
  const columns = schema.fields.filter((f) => f.key !== idField && !f.advanced);
  const filter = van.state('');

  // A 'file' field's stored value (see item-form-view.ts) is a blobRef/blob-store.ts id — an opaque
  // UUID, meaningless to a reader looking at this table. `fileNameKey` (when the Module declares
  // one) names a companion field holding the file's actual name, which is what a reader wants to
  // see here instead.
  function cellText(field: (typeof columns)[number], item: Record<string, unknown>): string {
    if (field.type === 'file' && field.fileNameKey) {
      const fileName = item[field.fileNameKey];
      if (typeof fileName === 'string' && fileName) return fileName;
    }
    return String(item[field.key] ?? '');
  }

  function matchesFilter(item: Record<string, unknown>): boolean {
    const query = filter.val.trim().toLowerCase();
    if (!query) return true;
    const haystack = columns
      .map((f) => cellText(f, item))
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  }

  function renderRow(item: Record<string, unknown>) {
    return tr(
      ...columns.map((field) =>
        td(
          field.key === schema.activeField && callbacks.onToggleActive
            ? input({
                type: 'checkbox',
                checked: Boolean(item[field.key]),
                onchange: () => callbacks.onToggleActive?.(item),
              })
            : cellText(field, item),
        ),
      ),
      td(
        { class: 'row-actions' },
        schema.rowAction
          ? button(
              {
                title: schema.rowAction.label,
                onclick: () => chrome.downloads.download({ url: String(item[schema.rowAction!.urlField]) }),
              },
              schema.rowAction.label,
            )
          : null,
        schema.readOnly ? null : button({ title: 'Edit', onclick: () => callbacks.onEdit(item) }, '✎'),
        button({ title: 'Delete', onclick: () => callbacks.onDelete(item) }, '✕'),
      ),
    );
  }

  // Function child: VanJS re-invokes this whenever a State read inside (`filter.val`) changes,
  // so typing in the filter box re-renders just the table, not the whole view.
  const tableSlot = div({ class: 'table-wrapper' }, () => {
    const visible = items.filter(matchesFilter);
    if (visible.length === 0) {
      return p(`No ${schema.itemLabel}s${filter.val ? ' match your filter' : ' yet'}.`);
    }
    return table(
      // `title` (not shown here in `f.label` itself) gives the same hover-only explanation as the
      // item form's info icon (see item-form-view.ts's infoIcon) — no icon glyph in a `<th>`,
      // since the whole header cell is already a natural hover target.
      thead(tr(...columns.map((f) => th(f.hint ? { title: f.hint } : {}, f.label)), th())),
      tbody(...visible.map(renderRow)),
    );
  });

  van.add(
    root,
    header(
      // h1 + description grouped together so `header`'s space-between only ever splits this block
      // from the button (left vs right) — without the wrapper, space-between treated title,
      // description, and button as three equal flex items, squeezing the description between them
      // instead of letting it sit on its own line under the title.
      div(
        h1(entry.label ?? entry.id),
        // Visible, not hover-only — this page header has room, unlike the popup's cramped row list
        // (list-view.ts uses `title` instead for the same `entry.description`).
        entry.description ? p({ class: 'module-description' }, entry.description) : null,
      ),
      schema.readOnly ? null : button({ onclick: callbacks.onAdd }, `+ Add ${schema.itemLabel}`),
    ),
    section(
      input({
        type: 'search',
        placeholder: `Filter ${schema.itemLabel}s...`,
        oninput: (e: Event) => {
          filter.val = (e.target as HTMLInputElement).value;
        },
      }),
      tableSlot,
    ),
  );
}
