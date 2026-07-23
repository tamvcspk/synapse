import van from 'vanjs-core';
import type { View } from '../router';

const { div, p } = van.tags;

/** Minimal — no cancel button, matching this popup's existing minimalism (docs/ROADMAP.md #1). A
 * long-running action (Crawl & Convert Site) updates `message` via progress pings; main.ts owns
 * re-rendering this view as those arrive. */
export function renderBusyView(root: HTMLElement, view: Extract<View, { kind: 'busy' }>): void {
  root.replaceChildren();
  van.add(root, div({ class: 'busy-view' }, p(view.message)));
}
