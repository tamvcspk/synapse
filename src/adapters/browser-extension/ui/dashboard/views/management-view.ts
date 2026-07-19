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
  const columns = schema.fields.filter((f) => f.key !== idField);
  const filter = van.state('');

  function matchesFilter(item: Record<string, unknown>): boolean {
    const query = filter.val.trim().toLowerCase();
    if (!query) return true;
    const haystack = columns
      .map((f) => String(item[f.key] ?? ''))
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
            : String(item[field.key] ?? ''),
        ),
      ),
      td(
        { class: 'row-actions' },
        button({ title: 'Edit', onclick: () => callbacks.onEdit(item) }, '✎'),
        button({ title: 'Delete', onclick: () => callbacks.onDelete(item) }, '✕'),
      ),
    );
  }

  // Function child: VanJS re-invokes this whenever a State read inside (`filter.val`) changes,
  // so typing in the filter box re-renders just the table, not the whole view.
  const tableSlot = div(() => {
    const visible = items.filter(matchesFilter);
    if (visible.length === 0) {
      return p(`No ${schema.itemLabel}s${filter.val ? ' match your filter' : ' yet'}.`);
    }
    return table(
      thead(tr(...columns.map((f) => th(f.label)), th())),
      tbody(...visible.map(renderRow)),
    );
  });

  van.add(
    root,
    header(
      h1(entry.label ?? entry.id),
      button({ onclick: callbacks.onAdd }, `+ Add ${schema.itemLabel}`),
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
