/**
 * Generic content-script-only UI mechanism (Environment SDK — see the sdk-layers skill's
 * mechanism-vs-policy rule; docs/ROADMAP.md #4.2, the first "Shadow DOM popover / In-Page Float
 * Widget" consumer). Content-scripts have no UI engine at all before this file — this is it.
 *
 * Zero knowledge of any particular Module's business ("media", "network-sniffer", ...) — callers
 * pass a fully-formed display payload. Renders inside a single shared `attachShadow({mode:'open'})`
 * host so the page's own CSS can never clobber the widget and the widget's styles never leak onto
 * the page — no Pico.css/VanJS here on purpose (those are extension-page-only tools per
 * docs/design.md §7; bundling a UI framework into every page a user visits is the wrong call).
 *
 * **All styling is applied via direct CSSOM property assignment (`el.style.xxx = value`), never a
 * `<style>` tag or a `style=""` string.** A `<style>` element is subject to the *page's own* CSP
 * `style-src` directive — on any site with a strict CSP (no `unsafe-inline`), the browser silently
 * drops it and the widget renders with zero layout, effectively invisible (this was a real bug in
 * this file's first version: the widget existed in the DOM but never showed on CSP-strict sites).
 * Programmatic CSSOM property assignment is not subject to `style-src` and works everywhere.
 */

export interface FloatingWidgetOptions {
  /** Stable id — a second call with the same id updates the existing card's text/action in place
   * instead of stacking a duplicate (keeps a chatty page from spamming multiple cards). */
  id: string;
  message: string;
  actionLabel?: string;
  /** Click handler for the action, when provided — a plain `<button>`, NOT a real
   * `<a href="chrome-extension://...">`. A page-context navigation to an extension URL is blocked
   * by Chrome ("This page has been blocked") unless that URL is listed in
   * `web_accessible_resources` — widening that just for this link would expose the whole target
   * page to any arbitrary website, a bigger surface than manifest.config.ts's deliberately narrow
   * `assets/*` scope. A button + message-to-background (see network-sniffer's
   * `synapse:open-dashboard` listener) avoids that entirely, same pattern as the anchored badge's
   * download click. */
  onAction?: () => void;
}

export interface AnchoredBadgeOptions {
  /** Stable id — a second call with the same id moves/relabels the existing badge instead of
   * creating a duplicate. */
  id: string;
  /** The element this badge tracks — repositioned every frame to stay pinned at its top-left
   * corner. Auto-removed once `target` leaves the document (e.g. SPA navigation). */
  target: Element;
  label: string;
  /** Native `title` attribute (hover tooltip) — e.g. flagging a best-effort/correlated match
   * (docs/ROADMAP.md #4.1's blob:/MSE badge) so the user isn't misled into treating it as certain
   * as a directly-resolved src. */
  title?: string;
  onClick: () => void;
}

let shadowRoot: ShadowRoot | null = null;

function ensureShadowRoot(): ShadowRoot {
  if (shadowRoot) return shadowRoot;

  const host = document.createElement('div');
  host.id = 'synapse-floating-widget-host';
  document.documentElement.appendChild(host);
  shadowRoot = host.attachShadow({ mode: 'open' });

  return shadowRoot;
}

const BASE_FONT = { fontFamily: 'system-ui, sans-serif', fontSize: '13px' };

function styled<K extends keyof HTMLElementTagNameMap>(tag: K, style: Partial<CSSStyleDeclaration>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  Object.assign(el.style, style);
  return el;
}

// --- Global toast stack (bottom-right) — used for detections with no on-page element to anchor to. ---

let stack: HTMLDivElement | null = null;

function ensureStack(): HTMLDivElement {
  if (stack) return stack;
  stack = styled('div', {
    position: 'fixed',
    bottom: '16px',
    right: '16px',
    zIndex: '2147483647',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    ...BASE_FONT,
  });
  ensureShadowRoot().appendChild(stack);
  return stack;
}

function buildCard(options: FloatingWidgetOptions): HTMLDivElement {
  const card = styled('div', {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    background: '#1f2328',
    color: '#f4f4f4',
    borderRadius: '8px',
    padding: '10px 12px',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.35)',
    maxWidth: '320px',
  });
  card.dataset.widgetId = options.id;

  const message = styled('span', { flex: '1' });
  message.className = 'message';
  card.appendChild(message);

  const action = styled('button', {
    background: 'none',
    border: 'none',
    color: '#7cb9ff',
    fontWeight: '600',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    padding: '0',
    ...BASE_FONT,
  });
  action.className = 'action';
  action.type = 'button';
  card.appendChild(action);

  const dismiss = styled('button', {
    background: 'none',
    border: 'none',
    color: '#aaa',
    cursor: 'pointer',
    fontSize: '15px',
    lineHeight: '1',
    padding: '0',
  });
  dismiss.type = 'button';
  dismiss.textContent = '×';
  dismiss.onclick = () => card.remove();
  card.appendChild(dismiss);

  return card;
}

function applyContent(card: HTMLDivElement, options: FloatingWidgetOptions): void {
  card.querySelector<HTMLSpanElement>('.message')!.textContent = options.message;

  const action = card.querySelector<HTMLButtonElement>('.action')!;
  if (options.onAction) {
    action.textContent = options.actionLabel ?? 'View';
    action.style.display = '';
    action.onclick = options.onAction;
  } else {
    action.style.display = 'none';
    action.onclick = null;
  }
}

/** Shows (or updates, if `options.id` is already showing) one floating card bottom-right. */
export function showFloatingWidget(options: FloatingWidgetOptions): void {
  const container = ensureStack();
  const existing = container.querySelector<HTMLDivElement>(`[data-widget-id="${CSS.escape(options.id)}"]`);
  const card = existing ?? buildCard(options);
  applyContent(card, options);
  if (!existing) container.appendChild(card);
}

/** Removes a widget by id, if currently showing — no-op otherwise. */
export function dismissFloatingWidget(id: string): void {
  stack?.querySelector(`[data-widget-id="${CSS.escape(id)}"]`)?.remove();
}

// --- Anchored badges — pinned to a specific element's corner (e.g. a <video> tag), tracked every
// frame via requestAnimationFrame rather than scroll/resize listeners: a video's ancestor could be
// any scrollable container, not just the window, so polling its rect is simpler and more reliable
// than trying to enumerate every scrollable ancestor to attach listeners to. ---

interface AnchoredBadge {
  el: HTMLButtonElement;
  target: Element;
}

const anchoredBadges = new Map<string, AnchoredBadge>();
let rafHandle: number | null = null;

function trackAnchoredBadges(): void {
  for (const [id, badge] of anchoredBadges) {
    if (!badge.target.isConnected) {
      badge.el.remove();
      anchoredBadges.delete(id);
      continue;
    }
    const rect = badge.target.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0;
    badge.el.style.display = visible ? 'flex' : 'none';
    if (visible) {
      badge.el.style.top = `${rect.top + 6}px`;
      badge.el.style.left = `${rect.left + 6}px`;
    }
  }
  rafHandle = anchoredBadges.size > 0 ? requestAnimationFrame(trackAnchoredBadges) : null;
}

/** Shows (or repositions/relabels, if `options.id` already exists) a small button pinned to the
 * top-left corner of `options.target`, tracking its position every frame until `target` is
 * removed from the document or `dismissAnchoredBadge` is called. */
export function showAnchoredBadge(options: AnchoredBadgeOptions): void {
  let badge = anchoredBadges.get(options.id);
  if (!badge) {
    const el = styled('button', {
      position: 'fixed',
      zIndex: '2147483647',
      background: '#1f2328',
      color: '#f4f4f4',
      border: 'none',
      borderRadius: '6px',
      padding: '3px 7px',
      cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.35)',
      lineHeight: '1.4',
      ...BASE_FONT,
    });
    el.type = 'button';
    ensureShadowRoot().appendChild(el);
    badge = { el, target: options.target };
    anchoredBadges.set(options.id, badge);
    if (rafHandle === null) rafHandle = requestAnimationFrame(trackAnchoredBadges);
  }
  badge.target = options.target;
  badge.el.textContent = options.label;
  badge.el.title = options.title ?? '';
  badge.el.onclick = options.onClick;
}

/** Removes an anchored badge by id, if currently showing — no-op otherwise. */
export function dismissAnchoredBadge(id: string): void {
  const badge = anchoredBadges.get(id);
  if (!badge) return;
  badge.el.remove();
  anchoredBadges.delete(id);
}
