import van from 'vanjs-core';
import type { RegistryEntry } from '../../../../../kernel/module-registry';

const { div, h1, p, header, section, ul, li, label, input, span } = van.tags;

export interface StepsViewCallbacks {
  onToggleSub(subId: string, active: boolean): void;
}

/**
 * Composite Module (docs/ROADMAP.md #3) per-step bypass view — the Dashboard-hosted counterpart of
 * what used to be a cramped inline row in the popup's list-view.ts. Reachable whenever a Module has
 * `subModules` regardless of its own `uiSchema` kind (an Action-schema Composite Module, e.g.
 * Reader Mode Converter, still gets this view even though its Gear/Arrow icon triggers `run()`
 * directly rather than opening the Dashboard — see main.ts's `hasSteps` branch).
 */
export function renderStepsView(root: HTMLElement, entry: RegistryEntry, callbacks: StepsViewCallbacks): void {
  root.replaceChildren();

  const subModules = entry.subModules ?? [];

  van.add(
    root,
    header(
      div(
        h1(entry.label ?? entry.id),
        entry.description ? p({ class: 'module-description' }, entry.description) : null,
      ),
    ),
    section(
      p('Bypass any step to skip it — its input passes through to the next step unchanged.'),
      ul(
        ...subModules.map((sub) =>
          li(
            label(
              input({
                type: 'checkbox',
                checked: entry.subState?.[sub.id] ?? true,
                onchange: (e: Event) => callbacks.onToggleSub(sub.id, (e.target as HTMLInputElement).checked),
              }),
              span(sub.label ?? sub.id),
            ),
          ),
        ),
      ),
    ),
  );
}
