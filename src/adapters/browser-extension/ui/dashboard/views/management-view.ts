import van from 'vanjs-core';
import type { RegistryEntry } from '../../../../../kernel/module-registry';
import type { UICollectionSchema, UIRowAction } from '../../../../../kernel/ui-schema';
import { icon, ICONS } from '../../icon';

const { div, h1, button, input, label, table, thead, tbody, tr, th, td, p, header, section, ul, li, a } = van.tags;

export interface ManagementViewCallbacks {
  onAdd(): void;
  onEdit(item: Record<string, unknown>): void;
  onToggleActive?(item: Record<string, unknown>): void;
  onDelete(item: Record<string, unknown>): void;
  /** Only needed when `schema.rowActions` contains a `'trigger'` kind — sends the op straight to
   * the Module's own bus listener (docs/ROADMAP.md #5.1), same "generic renderer, per-kind
   * optional callback" shape as `onToggleActive`. */
  onTrigger?(op: string, item: Record<string, unknown>): void;
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
  // docs/ROADMAP.md #5.2 — starts hidden (unchecked): schema.defaultHideField rows don't show up
  // until the user opts in, but nothing about them (search, dismiss) is disabled while hidden.
  const showHidden = van.state(false);

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
    if (schema.defaultHideField && !showHidden.val && item[schema.defaultHideField] === true) return false;
    const query = filter.val.trim().toLowerCase();
    if (!query) return true;
    const haystack = columns
      .map((f) => cellText(f, item))
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  }

  // `'smart-download'` (docs/ROADMAP.md §6.8) picks direct-download vs. engine-command at click
  // time, based on the item's own `kindField` value — same decision the Side Panel's single
  // "Download" button already makes (docs/ROADMAP.md §6). `urlOverride` lets a variants-column link
  // (below) reuse this exact branching for a specific variant's url instead of the row's own
  // `urlField`. docs/ROADMAP.md §8.1 — `engineKinds` used to `chrome.tabs.create` a Merge Tab; the
  // HLS engine now runs headless in a singleton Offscreen Document, so this just sends it a START
  // command instead. `jobId` is the row's own id (`schema.idField`, same convention the Side Panel
  // uses for its `entryId`) — Dashboard doesn't show progress for this (docs/ROADMAP.md §7.6's
  // existing "no progress UI here" scope), it only ever fires-and-forgets the start.
  function runSmartDownload(
    action: Extract<UIRowAction, { kind: 'smart-download' }>,
    item: Record<string, unknown>,
    urlOverride?: string,
  ): void {
    const url = urlOverride ?? String(item[action.urlField]);
    if (action.engineKinds.includes(String(item[action.kindField]))) {
      void chrome.runtime.sendMessage({
        type: 'synapse:download-engine-command',
        op: 'START',
        jobId: String(item[idField]),
        url,
      });
    } else {
      void chrome.downloads.download({ url });
    }
  }

  // docs/ROADMAP.md §6.8 — `schema.variantsField` names an item field holding `{url,label}[]`
  // (e.g. network-sniffer's per-video HLS resolution options, folded onto one entry since §6.3);
  // each one renders as its own small link in the same cell rather than as a separate row, so one
  // real item stays one table row no matter how many download options it offers. Clicking a
  // variant link runs the SAME `'smart-download'` action as the row's own button, just aimed at
  // that variant's url instead of the row's default `urlField`.
  const smartDownloadAction = schema.rowActions?.find(
    (a): a is Extract<UIRowAction, { kind: 'smart-download' }> => a.kind === 'smart-download',
  );

  function renderVariantsCell(item: Record<string, unknown>) {
    const variants = schema.variantsField ? item[schema.variantsField] : undefined;
    if (!Array.isArray(variants) || variants.length === 0) return null;
    return ul(
      { class: 'variant-list' },
      ...variants.map((v: { url: string; label: string }) =>
        li(
          a(
            {
              href: '#',
              onclick: (e: Event) => {
                e.preventDefault();
                if (smartDownloadAction) runSmartDownload(smartDownloadAction, item, v.url);
              },
            },
            v.label,
          ),
        ),
      ),
    );
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
      schema.variantsField ? td(renderVariantsCell(item)) : null,
      td(
        { class: 'row-actions' },
        ...(schema.rowActions ?? []).map((action) =>
          button(
            {
              title: action.label,
              onclick: () => {
                if (action.kind === 'download') {
                  void chrome.downloads.download({ url: String(item[action.urlField]) });
                } else if (action.kind === 'open-tab') {
                  const url = `${chrome.runtime.getURL(action.path)}?url=${encodeURIComponent(String(item[action.urlField]))}`;
                  void chrome.tabs.create({ url });
                } else if (action.kind === 'smart-download') {
                  runSmartDownload(action, item);
                } else {
                  callbacks.onTrigger?.(action.op, item);
                }
              },
            },
            action.label,
          ),
        ),
        schema.readOnly ? null : button({ title: 'Edit', 'aria-label': 'Edit', onclick: () => callbacks.onEdit(item) }, icon(ICONS.squarePen)),
        button({ title: 'Delete', 'aria-label': 'Delete', onclick: () => callbacks.onDelete(item) }, icon(ICONS.x)),
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
      thead(
        tr(
          ...columns.map((f) => th(f.hint ? { title: f.hint } : {}, f.label)),
          schema.variantsField ? th(schema.variantsLabel ?? 'Options') : null,
          th(),
        ),
      ),
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
      // docs/ROADMAP.md #5.2 — only rendered when the schema actually declares a field to hide;
      // most Collection schemas have no `defaultHideField` and get no toggle.
      schema.defaultHideField
        ? label(
            { class: 'show-hidden-toggle' },
            input({
              type: 'checkbox',
              checked: showHidden.val,
              onchange: (e: Event) => {
                showHidden.val = (e.target as HTMLInputElement).checked;
              },
            }),
            ` Show hidden ${schema.itemLabel}s`,
          )
        : null,
      tableSlot,
    ),
  );
}
