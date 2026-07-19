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
  root.innerHTML = '';

  const container = document.createElement('div');
  container.className = 'action-result-form' + (props.isError ? ' is-error' : '');

  const title = document.createElement('p');
  title.textContent = props.title;

  const textarea = document.createElement('textarea');
  textarea.readOnly = true;
  textarea.rows = 10;
  textarea.value = props.content;

  const menu = document.createElement('menu');

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => {
    void navigator.clipboard.writeText(props.content);
    copyBtn.textContent = 'Copied!';
    setTimeout(() => {
      copyBtn.textContent = 'Copy';
    }, 1200);
  });

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.textContent = '←';
  backBtn.title = 'Back';
  backBtn.addEventListener('click', callbacks.onBack);

  menu.append(copyBtn, backBtn);
  container.append(title, textarea, menu);
  root.append(container);
}
