import type { RegistryEntry } from '../../../../kernel/module-registry';
import type { UICollectionSchema } from '../../../../kernel/ui-schema';

export interface ManagementViewCallbacks {
  onBack(): void;
  onAdd(): void;
  onEdit(item: Record<string, unknown>): void;
  onToggleActive?(item: Record<string, unknown>): void;
  onDelete(item: Record<string, unknown>): void;
}

/**
 * Generic CRUD renderer driven entirely by a UICollectionSchema (docs/ROADMAP.md #2) — replaces
 * the hand-written renderMockConfigSection/renderMockConfigRow. Only ever sees
 * Record<string, unknown> items, never a module-specific type like MockConfig.
 */
export function renderManagementView(
  root: HTMLElement,
  entry: RegistryEntry,
  schema: UICollectionSchema,
  items: Record<string, unknown>[],
  callbacks: ManagementViewCallbacks,
): void {
  root.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'header';

  const backBtn = document.createElement('button');
  backBtn.textContent = '←';
  backBtn.title = 'Back';
  backBtn.addEventListener('click', callbacks.onBack);

  const title = document.createElement('h1');
  title.textContent = entry.label ?? entry.id;

  const addBtn = document.createElement('button');
  addBtn.textContent = '+';
  addBtn.title = `Add ${schema.itemLabel}`;
  addBtn.addEventListener('click', callbacks.onAdd);

  header.append(backBtn, title, addBtn);
  root.append(header);

  const filterInput = document.createElement('input');
  filterInput.type = 'search';
  filterInput.placeholder = `Filter ${schema.itemLabel}s...`;
  filterInput.className = 'management-filter';
  root.append(filterInput);

  const tableContainer = document.createElement('div');
  root.append(tableContainer);

  const idField = schema.idField ?? 'id';
  const columns = schema.fields.filter((f) => f.key !== idField);

  function matchesFilter(item: Record<string, unknown>, query: string): boolean {
    if (!query) return true;
    const haystack = columns
      .map((f) => String(item[f.key] ?? ''))
      .join(' ')
      .toLowerCase();
    return haystack.includes(query.toLowerCase());
  }

  function renderTable(): void {
    tableContainer.innerHTML = '';
    const visibleItems = items.filter((item) => matchesFilter(item, filterInput.value));

    if (visibleItems.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'management-empty';
      empty.textContent = `No ${schema.itemLabel}s${filterInput.value ? ' match your filter' : ' yet'}.`;
      tableContainer.append(empty);
      return;
    }

    const table = document.createElement('table');
    table.className = 'management-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const field of columns) {
      const th = document.createElement('th');
      th.textContent = field.label;
      headRow.append(th);
    }
    headRow.append(document.createElement('th')); // actions column
    thead.append(headRow);
    table.append(thead);

    const tbody = document.createElement('tbody');
    for (const item of visibleItems) {
      const row = document.createElement('tr');
      for (const field of columns) {
        const cell = document.createElement('td');
        if (field.key === schema.activeField && callbacks.onToggleActive) {
          const toggle = document.createElement('input');
          toggle.type = 'checkbox';
          toggle.checked = Boolean(item[field.key]);
          toggle.addEventListener('change', () => callbacks.onToggleActive?.(item));
          cell.append(toggle);
        } else {
          cell.textContent = String(item[field.key] ?? '');
        }
        row.append(cell);
      }

      const actionsCell = document.createElement('td');
      const editBtn = document.createElement('button');
      editBtn.textContent = '✎';
      editBtn.title = 'Edit';
      editBtn.addEventListener('click', () => callbacks.onEdit(item));
      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = '✕';
      deleteBtn.title = 'Delete';
      deleteBtn.addEventListener('click', () => callbacks.onDelete(item));
      actionsCell.append(editBtn, deleteBtn);
      row.append(actionsCell);

      tbody.append(row);
    }
    table.append(tbody);
    tableContainer.append(table);
  }

  filterInput.addEventListener('input', renderTable);
  renderTable();
}
