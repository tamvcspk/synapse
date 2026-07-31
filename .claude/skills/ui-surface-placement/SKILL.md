---
name: ui-surface-placement
description: Decide which UI surface a new browser-extension feature belongs on — toolbar Popup, Dashboard (New Tab), in-page Shadow-DOM overlay, or Side Panel — and whether the toolbar icon should be a single-action trigger or open a multi-action menu. Use when scaffolding a module's `uiSchema`/`uiParadigm`, or reviewing where an existing feature's UI lives. Matches docs/design.md §7 Execution Contexts and docs/ROADMAP.md §2/§4.
---

# UI Surface Placement

A browser extension has limited screen real estate and runs as a guest inside someone else's page.
The goal is minimizing **friction** and preserving **context**. This skill is the decision framework
for picking a surface — it does not itself imply any surface exists in Synapse beyond what
`docs/design.md` §7 documents as implemented today.

## The four surfaces

### 1. Toolbar Popup (`ui/popup/`)
**Transient** — closes the instant the user clicks elsewhere. Small frame.
- Use for: interactions **under ~10 seconds**, global extension toggles, triggering a short
  action, confirming a quick step.
- Never for: long-running operations (the result is lost if the user clicks away before it
  finishes), multi-step forms, anything needing to stay open while the user refers back to the
  page.
- Today: Module Registry list/toggle, and any Action-schema Module's `run()` that completes
  quickly (docs/design.md §7 Popup).

### 2. Dashboard / New Tab (`ui/dashboard/`, opened via `chrome.tabs.create`)
**Deep focus** — effectively unlimited space, no auto-close.
- Use for: CRUD/Collection-schema management, settings, batch results, anything that benefits
  from a table/form/wide layout, or any operation whose duration could exceed Popup's transient
  lifetime.
- Today: Management View, Steps view (composite-module bypass toggles), Review/ZIP page
  (docs/design.md §7 Dashboard).

### 3. In-page Shadow-DOM overlay (content-script injection)
**Contextual** — tied to a specific DOM element or point on the page, not the whole page.
- Use for: an action that only makes sense anchored to something the user is looking at right
  now (a video element, a selected phrase). Must be near-zero-intrusion: never render unless
  triggered, never break host-page layout.
- Crucial technical rule (learned the hard way, ROADMAP §4.2): never a `<style>` tag or an inline
  `style=""` string — both are subject to the **host page's** `style-src` CSP and get silently
  dropped on strict sites, even from an isolated world. Use `adoptedStyleSheets` (real CSS text,
  not CSP-gated — verified Chrome 150, see `docs/LESSONS.md`) or direct CSSOM assignment.
- How to actually build one: `in-page-ui-engine` skill.
- Today: `network-sniffer`'s anchored badge + toast fallback (docs/ROADMAP.md §4.2).

### 4. Side Panel (`chrome.sidePanel`)
**Parallel and persistent** — stays open across tab navigation, doesn't cover page content.
- Use for: multi-turn interaction that needs to reference the page repeatedly — an AI
  chat/copilot about the current page, long-form translation, notes taken alongside reading.
- First used by `network-sniffer` (docs/ROADMAP.md §6) — a bespoke VanJS renderer, not the
  Dashboard's generic Management View table. Still the natural target for a future
  `ai`-capability Module needing sustained back-and-forth (design.md §6's `PersonaAutomationAgent`
  shape) — don't retrofit that kind of interaction into Dashboard (loses "parallel, doesn't cover
  the page") or Popup (dies on click-away) instead.
- **`chrome.sidePanel.open()` must be called synchronously, with no `await` before it, in the same
  tick as the triggering message handler** — the user-gesture carried through
  `chrome.runtime.sendMessage` from a content-script click expires after a microtask. See
  `docs/LESSONS.md` before touching any code path that opens the panel or calls
  `chrome.sidePanel.setOptions`.

## Toolbar icon: single action vs menu

- **Single-action button** (`chrome.action.onClicked`, no `default_popup`): only correct when the
  *entire* extension has exactly one core function. Not Synapse's shape — it's a multi-module
  toolkit, so the icon opens the Popup's module list/menu.
- **Per-module toolbar single-action (`uiParadigm: 'action-button'`) — tried, then abandoned, don't
  redo it.** Was actually coded (dynamically swapping `chrome.action.setPopup({popup: ''})` per
  active module, since a statically-declared `default_popup` swallows every click before
  `onClicked` can fire) and then reverted — see docs/ROADMAP.md §6's decision history. Mid-build,
  the real ask turned out to be an icon **inside** the address bar itself (Google Translate/Cốc
  Cốc-style) — there is no public extension API for that on Chrome; `chrome.action` only ever
  places an icon *beside* the address bar. The chosen replacement for "one click opens a
  page-scoped panel" is the **in-page floating Shadow-DOM icon** (surface #3 above) triggering the
  **Side Panel** (surface #4), not a toolbar icon — see `network-sniffer` (docs/ROADMAP.md §6) for
  the shipped shape. `uiParadigm: 'action-button'` still exists as a type value but no Module uses
  it; don't reach for it without re-confirming with the user first, since this exact path was
  already tried and rejected once.

## Quick placement checklist

1. Does the action need to reference a specific DOM element the user is looking at right now? →
   in-page Shadow-DOM overlay (optionally as the trigger for a Side Panel — see `network-sniffer`).
2. Will it finish in a few seconds and not need the user to keep looking at the page? → Popup.
3. Does it need a form, a table, unbounded space, or could it run long enough that Popup's
   transient lifetime is a problem? → Dashboard (New Tab).
4. Does it need multi-turn back-and-forth alongside the page, persisting across tab switches? →
   Side Panel (built and shipped for `network-sniffer`, docs/ROADMAP.md §6 — reuse that kernel
   wiring, §6.2, rather than redoing it for a second Module).
