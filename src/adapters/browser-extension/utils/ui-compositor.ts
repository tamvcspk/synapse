/**
 * The in-page UI compositor (docs/ROADMAP.md §11.4 Phase 3) — replaces `utils/floating-widget.ts`,
 * whose model was *id supplied by the caller in one shared namespace*: every consumer wrote into one
 * shadow root, one toast stack and one icon row keyed by `options.id`, so any caller could
 * `dismissFloatingIcon('<someone-else's-id>')`. That is the same defect class as the `cache`
 * privilege-escalation hole (docs/ROADMAP.md §11.3): **identity coming from the caller instead of
 * from the transport.** It never fired only because the three consumers were ours.
 *
 * The model here: a script never receives a node in shared space. It asks for a *surface*
 * (`createUiSurface(ownerId)`) and the platform allocates and positions it. `ownerId` is supplied by
 * whoever constructs the surface — the composition root, using a build-time Module id or the shim's
 * per-script closure constant — and never by the code calling `toast()`/`icon()`.
 *
 * ## Two worlds, one document
 *
 * This runs in the extension's ISOLATED content-script world (for bundled Modules). Uploaded user
 * scripts get an equivalent in their own USER_SCRIPT world from `user-script-shim.ts`, because
 * docs/ROADMAP.md §11.0 settled that the UI engine runs in the same world as the code declaring the
 * UI (a Core-side engine kills closures: `onClick` cannot cross structured clone).
 *
 * The two worlds share no JS state — no registry, no counter, no lock — but they DO share the
 * document. So everything cross-cutting is expressed in the DOM and re-derived from it:
 *
 * - **The host, the zones and the stylesheet are shared**, discovered via `#synapse-ui-root`.
 *   Whichever world arrives first creates what is missing; the other completes it (`data-styled`).
 * - **Ordering comes from sorting owner ids**, never from creation order — see
 *   `shared/ui/surface-policy.ts`'s `insertionIndexFor`. Creation order across two worlds is a race
 *   by definition, so it can never be the answer.
 *
 * ## What is NOT promised
 *
 * Event isolation. A script can `document.addEventListener('click', …)` and observe clicks landing
 * on another script's widget, and nothing here can prevent that — the same reason `page.dom` is a
 * Disclosed scope. What IS guaranteed: the API gives a caller no way to *address* another owner's
 * surface, and no surface can cover another's hit-testing (the root is `pointer-events: none`, only
 * real widgets opt back in).
 *
 * ## Styling — `adoptedStyleSheets`, never `<style>`
 *
 * Verified on real Chrome 150 (docs/LESSONS.md): a constructed stylesheet is not subject to the host
 * page's `style-src`, while a `<style>` element and a `style=""` attribute both are and get silently
 * dropped on strict sites. The previous version of this file worked around that by assigning every
 * property through CSSOM (`el.style.x = …`), which is also CSP-immune but cannot express `:hover`,
 * media queries or pseudo-elements. One constructed sheet, adopted once into the shared root, lifts
 * that limitation.
 *
 * Per-owner *nested* shadow roots (docs/ROADMAP.md §11.4) are deliberately NOT built yet: their
 * whole benefit is keeping one script's CSS out of another's, and in this phase no script supplies
 * CSS — the API is imperative with three fixed shapes. Adding them now would force the CSS text to
 * be duplicated into the shim as well. They belong with the declarative engine (Phase 6), which is
 * the first thing that lets a script bring its own styles.
 */

import {
  admitToast,
  createToastBudget,
  insertionIndexFor,
  isKeyOf,
  surfaceKey,
  withinQuota,
  type SurfaceKind,
  type ToastBudget,
} from '../../../shared/ui/surface-policy';

const ROOT_ID = 'synapse-ui-root';
const ZONE_ATTR = 'data-zone';
const OWNER_ATTR = 'data-owner';
const KEY_ATTR = 'data-key';
/** Marks ONE owner container as hidden. Separate from the root-level list below: the list is the
 * state, this is how it is applied to a container that already exists. */
const HIDDEN_OWNER_ATTR = 'data-hidden';

type ZoneName = 'icons' | 'toasts' | 'badges';

const ZONE_FOR: Record<SurfaceKind, ZoneName> = { icon: 'icons', toast: 'toasts', badge: 'badges' };

/** Kept in one string so it is adopted once per world rather than re-parsed per widget. */
const COMPONENT_CSS = `
.syn-zone {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font: 13px/1.4 system-ui, sans-serif;
}
.syn-zone[${ZONE_ATTR}="icons"] { top: 16px; right: 16px; }
.syn-zone[${ZONE_ATTR}="toasts"] { bottom: 16px; right: 16px; }
.syn-zone[${ZONE_ATTR}="badges"] { inset: 0; display: block; }
.syn-owner { display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
.syn-zone[${ZONE_ATTR}="badges"] .syn-owner { display: contents; }
/* The hide valve. \`!important\` because the badges-zone rule above is more specific and would
   otherwise win — and because this rule must never lose to anything, it being the one the user
   pressed a button to get. Scoped to our own shadow root, so it competes with nothing else. */
.syn-owner[${HIDDEN_OWNER_ATTR}] { display: none !important; }

.syn-icon, .syn-toast, .syn-badge { pointer-events: auto; }

.syn-icon {
  width: 32px; height: 32px;
  border: none; border-radius: 999px;
  background: #1f2328; color: #f4f4f4;
  font: inherit; line-height: 1; cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  transition: transform 120ms ease, background 120ms ease;
}
.syn-icon:hover { background: #2f3540; transform: scale(1.08); }
.syn-icon:focus-visible { outline: 2px solid #7cb9ff; outline-offset: 2px; }

.syn-toast {
  display: flex; align-items: center; gap: 10px;
  max-width: 320px; padding: 10px 12px;
  border-radius: 8px;
  background: #1f2328; color: #f4f4f4;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.syn-toast-message { flex: 1; }
.syn-toast-action, .syn-toast-close {
  background: none; border: none; padding: 0;
  font: inherit; cursor: pointer;
}
.syn-toast-action { color: #7cb9ff; font-weight: 600; white-space: nowrap; }
.syn-toast-action:hover { text-decoration: underline; }
.syn-toast-close { color: #aaa; font-size: 15px; line-height: 1; }
.syn-toast-close:hover { color: #f4f4f4; }

.syn-badge {
  position: absolute;
  border: none; border-radius: 6px;
  padding: 3px 7px;
  background: #1f2328; color: #f4f4f4;
  font: 13px/1.4 system-ui, sans-serif;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}
.syn-badge:hover { background: #2f3540; }

@media (prefers-reduced-motion: reduce) {
  .syn-icon { transition: none; }
}
`;

let sheet: CSSStyleSheet | null = null;

function componentSheet(): CSSStyleSheet {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(COMPONENT_CSS);
  }
  return sheet;
}

/**
 * The shared root, created by whichever world gets here first. Two worlds can genuinely race to
 * create it (both inject at `document_start`), so a duplicate is resolved by keeping the FIRST host
 * in document order — a rule both worlds evaluate identically, unlike "keep mine".
 */
function ensureRoot(): ShadowRoot {
  let host = document.getElementById(ROOT_ID);

  if (!host) {
    host = document.createElement('div');
    host.id = ROOT_ID;
    document.documentElement.appendChild(host);

    const all = document.querySelectorAll(`#${ROOT_ID}`);
    if (all.length > 1) {
      // Lost the race. Drop ours and take the winner; never the other way round.
      const winner = all[0] as HTMLElement;
      if (winner !== host) {
        host.remove();
        host = winner;
      }
    }
  }

  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });

  // The other world may have created the host without styling it (or vice versa) — whoever notices
  // the gap fills it, so neither world has to run first for the UI to be styled.
  if (host.dataset.styled !== '1') {
    host.dataset.styled = '1';
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, componentSheet()];
  }

  // Checked per zone, NOT inside the `data-styled` branch above: the shim creates zones without
  // styling (it has no stylesheet), so a bare `appendChild` loop here would append a second set on
  // top of the shim's and `zoneEl`'s `querySelector` would then resolve to whichever came first.
  for (const zone of ['icons', 'toasts', 'badges'] as ZoneName[]) {
    if (root.querySelector(`.syn-zone[${ZONE_ATTR}="${zone}"]`)) continue;
    const el = document.createElement('div');
    el.className = 'syn-zone';
    el.setAttribute(ZONE_ATTR, zone);
    root.appendChild(el);
  }

  return root;
}

/**
 * Installs the host, the zones and the stylesheet, drawing nothing.
 *
 * **Must be called unconditionally at content-script startup**, and it exists as its own exported
 * function precisely so that is possible. The bug it fixes (found on real Chrome, docs/ROADMAP.md
 * §11.4): styling used to be a side effect of `acquire()` — the ISOLATED world adopted the
 * stylesheet only if a *bundled* Module happened to draw something. On a page where none does
 * (no media detected, reader-mode's icons hidden or its Module off — i.e. the common case), the
 * sheet was never adopted at all, and because the shim deliberately owns no CSS, **every uploaded
 * script's UI rendered unstyled**: static divs in normal document flow, since `.syn-zone`'s
 * `position: absolute` and the host's fixed inset both live in that sheet.
 *
 * The general shape of the mistake is worth remembering: a shared resource that one party is
 * documented to own must be installed by that party *unconditionally*, never as a by-product of it
 * using the resource for its own purposes.
 */
export function installUiStyles(): void {
  ensureRoot();
}

// --- Hidden owners, expressed in the DOM ---------------------------------------------------------
// The "hide UI" valve (docs/ROADMAP.md §11.4) has to reach BOTH worlds, and only one of them can
// read `chrome.storage`: the USER_SCRIPT world has no storage access, and a shim asking over RPC
// would be async — a script drawing at document_start would already be on screen. So the flag lives
// on the shared host as an attribute: the ISOLATED world (which does have storage) writes it, and
// both worlds read it synchronously on every call, off the same single source.
//
// Owner ids never contain a space (uuids and build-time identifiers), which is what makes a
// space-separated list unambiguous — the same style of invariant `surfaceKey` relies on.
const HIDDEN_ATTR = 'data-hidden-owners';

function hiddenOwners(): string[] {
  const raw = document.getElementById(ROOT_ID)?.getAttribute(HIDDEN_ATTR);
  return raw ? raw.split(' ').filter(Boolean) : [];
}

export function isOwnerUiHidden(ownerId: string): boolean {
  return hiddenOwners().includes(ownerId);
}

/**
 * Marks an owner's UI hidden (or visible again) for every world at once.
 *
 * **Hiding does NOT tear the surfaces down — it stops them being displayed.** The first version did
 * destroy them, and that made the valve one-way: un-hiding could only restore UI for an owner able
 * to redraw itself on demand (`reader-mode-converter`, whose icons are unconditional). It could
 * never restore an uploaded script's UI, because that UI was drawn imperatively by code that has
 * already finished running and the platform keeps no record to replay. Found on real Chrome:
 * "hide works instantly, show does nothing until reload".
 *
 * Keeping the nodes and toggling their visibility makes the valve symmetric for every kind of owner
 * with no replay mechanism at all — and it means a surface drawn *while* hidden simply appears when
 * the user unhides, instead of being lost.
 */
export function setOwnerUiHidden(ownerId: string, hidden: boolean): void {
  const host = document.getElementById(ROOT_ID) ?? ensureRoot().host;

  const next = new Set(hiddenOwners());
  if (hidden) next.add(ownerId);
  else next.delete(ownerId);
  host.setAttribute(HIDDEN_ATTR, [...next].join(' '));

  // Apply to containers that already exist. Ones created later pick it up in `ownerContainer`.
  for (const zone of ['icons', 'toasts', 'badges'] as ZoneName[]) {
    const container = findOwnerContainer(zone, ownerId);
    if (!container) continue;
    if (hidden) container.setAttribute(HIDDEN_OWNER_ATTR, '');
    else container.removeAttribute(HIDDEN_OWNER_ATTR);
  }
}

function zoneEl(zone: ZoneName): HTMLElement {
  const root = ensureRoot();
  return root.querySelector<HTMLElement>(`.syn-zone[${ZONE_ATTR}="${zone}"]`)!;
}

/**
 * The owner's container inside one zone, created at the position its id sorts to. Every surface an
 * owner creates lives inside its own container, which is what makes teardown one `remove()` and
 * makes a colliding local id between two owners harmless.
 */
function ownerContainer(zone: ZoneName, ownerId: string): HTMLElement {
  const parent = zoneEl(zone);
  const existing = parent.querySelector<HTMLElement>(`:scope > [${OWNER_ATTR}="${CSS.escape(ownerId)}"]`);
  if (existing) return existing;

  const el = document.createElement('div');
  el.className = 'syn-owner';
  el.setAttribute(OWNER_ATTR, ownerId);
  // A container created while its owner is hidden must be born hidden, or drawing during a mute
  // would flash UI the user has switched off.
  if (isOwnerUiHidden(ownerId)) el.setAttribute(HIDDEN_OWNER_ATTR, '');

  const siblings = [...parent.children].map((c) => c.getAttribute(OWNER_ATTR) ?? '');
  const index = insertionIndexFor(siblings, ownerId);
  parent.insertBefore(el, parent.children[index] ?? null);
  return el;
}

function findOwnerContainer(zone: ZoneName, ownerId: string): HTMLElement | null {
  const host = document.getElementById(ROOT_ID);
  const root = host?.shadowRoot;
  return root?.querySelector<HTMLElement>(`.syn-zone[${ZONE_ATTR}="${zone}"] > [${OWNER_ATTR}="${CSS.escape(ownerId)}"]`) ?? null;
}

// --- Anchored badge tracking -------------------------------------------------------------------
// Position is polled every frame rather than driven by scroll/resize listeners: the anchor's
// scrollable ancestor can be any element, not just the window, so enumerating what to listen to is
// strictly harder than re-reading the rect.

interface TrackedBadge {
  el: HTMLElement;
  target: Element;
}

const trackedBadges = new Map<string, TrackedBadge>();
let rafHandle: number | null = null;

function trackBadges(): void {
  for (const [key, badge] of trackedBadges) {
    if (!badge.target.isConnected || !badge.el.isConnected) {
      badge.el.remove();
      trackedBadges.delete(key);
      continue;
    }
    const rect = badge.target.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0;
    badge.el.style.display = visible ? '' : 'none';
    if (visible) {
      badge.el.style.top = `${rect.top + 6}px`;
      badge.el.style.left = `${rect.left + 6}px`;
    }
  }
  rafHandle = trackedBadges.size > 0 ? requestAnimationFrame(trackBadges) : null;
}

// --- Public surface ----------------------------------------------------------------------------

export interface ToastOptions {
  /** Local to this owner. Reusing it updates that toast in place instead of stacking a duplicate. */
  id: string;
  message: string;
  actionLabel?: string;
  /** Rendered as a `<button>`, never an `<a href="chrome-extension://…">` — a page-context
   * navigation to an extension URL is blocked unless the target is in `web_accessible_resources`,
   * and widening that exposes a privileged page to every site. Message the background instead. */
  onAction?: () => void;
}

export interface IconOptions {
  id: string;
  /** Glyph or emoji. Icons carry no count — the real numbers live in the Side Panel. */
  label: string;
  title?: string;
  onClick: () => void;
}

export interface BadgeOptions {
  id: string;
  /** Anchor element. The badge is removed automatically once this leaves the document. */
  target: Element;
  label: string;
  title?: string;
  onClick: () => void;
}

export interface UiSurface {
  /**
   * `false` when the call was refused (quota exhausted, or the toast rate limit) — never a silent
   * no-op.
   *
   * Being hidden by the user is NOT a refusal and returns `true`: the surface really is created,
   * the user has simply chosen not to look at it, and it appears the moment they unhide. Reporting
   * that as failure would push every caller into retry logic for a state that is not an error.
   */
  toast(options: ToastOptions): boolean;
  icon(options: IconOptions): boolean;
  badge(options: BadgeOptions): boolean;
  dismiss(kind: SurfaceKind, id: string): void;
  /** Removes every surface this owner has, in every zone. */
  clear(): void;
}

/**
 * One owner's handle onto the shared surface. `ownerId` must come from the transport — a build-time
 * Module id here, the shim's per-script constant for uploaded scripts — and is the only identity
 * anything in this file trusts.
 */
export function createUiSurface(ownerId: string): UiSurface {
  let budget: ToastBudget = createToastBudget(Date.now());

  const countOf = (kind: SurfaceKind): number =>
    findOwnerContainer(ZONE_FOR[kind], ownerId)?.querySelectorAll(`[${KEY_ATTR}]`).length ?? 0;

  const findExisting = (kind: SurfaceKind, id: string): HTMLElement | null =>
    findOwnerContainer(ZONE_FOR[kind], ownerId)?.querySelector<HTMLElement>(
      `[${KEY_ATTR}="${CSS.escape(surfaceKey(ownerId, id))}"]`,
    ) ?? null;

  /** Reuse-or-create, with the quota check applied ONLY to creation — an owner refreshing its own
   * icon every second must not eventually be told it is out of budget. */
  const acquire = (kind: SurfaceKind, id: string, build: () => HTMLElement): HTMLElement | null => {
    const existing = findExisting(kind, id);
    if (existing) return existing;
    if (!withinQuota(kind, countOf(kind))) return null;

    const el = build();
    el.setAttribute(KEY_ATTR, surfaceKey(ownerId, id));
    ownerContainer(ZONE_FOR[kind], ownerId).appendChild(el);
    return el;
  };

  const surface: UiSurface = {
    toast(options) {
      const existing = findExisting('toast', options.id);
      if (!existing) {
        const decision = admitToast(budget, Date.now());
        budget = decision.next;
        if (!decision.admitted) return false;
      }

      const card =
        existing ??
        acquire('toast', options.id, () => {
          const el = document.createElement('div');
          el.className = 'syn-toast';

          const message = document.createElement('span');
          message.className = 'syn-toast-message';
          el.appendChild(message);

          const action = document.createElement('button');
          action.type = 'button';
          action.className = 'syn-toast-action';
          el.appendChild(action);

          const close = document.createElement('button');
          close.type = 'button';
          close.className = 'syn-toast-close';
          close.textContent = '×';
          close.onclick = () => el.remove();
          el.appendChild(close);

          return el;
        });
      if (!card) return false;

      card.querySelector<HTMLElement>('.syn-toast-message')!.textContent = options.message;
      const action = card.querySelector<HTMLButtonElement>('.syn-toast-action')!;
      if (options.onAction) {
        action.textContent = options.actionLabel ?? 'View';
        action.style.display = '';
        action.onclick = options.onAction;
      } else {
        action.style.display = 'none';
        action.onclick = null;
      }
      return true;
    },

    icon(options) {
      const el = acquire('icon', options.id, () => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'syn-icon';
        return button;
      });
      if (!el) return false;

      el.textContent = options.label;
      if (options.title !== undefined) el.title = options.title;
      (el as HTMLButtonElement).onclick = options.onClick;
      return true;
    },

    badge(options) {
      const el = acquire('badge', options.id, () => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'syn-badge';
        return button;
      });
      if (!el) return false;

      el.textContent = options.label;
      el.title = options.title ?? '';
      (el as HTMLButtonElement).onclick = options.onClick;

      trackedBadges.set(surfaceKey(ownerId, options.id), { el, target: options.target });
      if (rafHandle === null) rafHandle = requestAnimationFrame(trackBadges);
      return true;
    },

    dismiss(kind, id) {
      findExisting(kind, id)?.remove();
      if (kind === 'badge') trackedBadges.delete(surfaceKey(ownerId, id));
    },

    clear() {
      for (const zone of ['icons', 'toasts', 'badges'] as ZoneName[]) {
        findOwnerContainer(zone, ownerId)?.remove();
      }
      for (const key of [...trackedBadges.keys()]) {
        if (isKeyOf(ownerId, key)) trackedBadges.delete(key);
      }
    },
  };

  return surface;
}

/** Tears down an owner's UI without needing its surface handle — for deactivation and deletion,
 * where the composition root knows the id but may never have constructed a surface. */
export function destroyUiSurface(ownerId: string): void {
  createUiSurface(ownerId).clear();
}
