import van from 'vanjs-core';
import { icon, ICONS } from '../../icon';

const { div, p, textarea, button } = van.tags;

/**
 * In-flow result view for Action-schema modules (docs/ROADMAP.md #1/#2). Renders directly into
 * #root instead of a native <dialog> — a Chrome MV3 popup auto-sizes to document.body's normal
 * flow, but a <dialog>'s top-layer content is excluded from that calculation, so it can render
 * (and have its buttons sit) outside the popup's actual on-screen bounds. See
 * .claude/skills/module-registry/SKILL.md for the "never use <dialog> in this popup" rule.
 */
export interface ActionResultViewProps {
  title: string;
  content: string;
  isError: boolean;
}

export interface ActionResultViewCallbacks {
  onBack(): void;
}

export function renderActionResultView(
  root: HTMLElement,
  props: ActionResultViewProps,
  callbacks: ActionResultViewCallbacks,
): void {
  root.replaceChildren();

  const copyBtn = button({ type: 'button', class: 'secondary' }, 'Copy');
  copyBtn.onclick = () => {
    void navigator.clipboard.writeText(props.content);
    copyBtn.textContent = 'Copied!';
    setTimeout(() => {
      copyBtn.textContent = 'Copy';
    }, 1200);
  };

  van.add(
    root,
    div(
      { class: 'action-result-form' + (props.isError ? ' is-error' : '') },
      p(props.title),
      textarea({ readonly: true, rows: 10 }, props.content),
      div(
        { class: 'form-actions' },
        button({ type: 'button', class: 'secondary', onclick: callbacks.onBack }, icon(ICONS.arrowLeft), ' Back'),
        copyBtn,
      ),
    ),
  );
}
