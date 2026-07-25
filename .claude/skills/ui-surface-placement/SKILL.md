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
- Crucial technical rule (already learned the hard way, ROADMAP §4.2): style via CSSOM
  (`el.style.xxx = …`) not a `<style>` tag or inline `style=""` string — a `<style>` tag is
  subject to the **host page's** `style-src` CSP and gets silently dropped on strict sites.
- Today: `network-sniffer`'s anchored badge + toast fallback (docs/ROADMAP.md §4.2).

### 4. Side Panel (`chrome.sidePanel`)
**Parallel and persistent** — stays open across tab navigation, doesn't cover page content.
- Use for: multi-turn interaction that needs to reference the page repeatedly — an AI
  chat/copilot about the current page, long-form translation, notes taken alongside reading.
- **Not used by any Synapse module today.** This is the natural target for a future `ai`-capability
  Module needing sustained back-and-forth (design.md §6's `PersonaAutomationAgent` shape), should
  one ever be built — don't retrofit that kind of interaction into Dashboard (loses "parallel,
  doesn't cover the page") or Popup (dies on click-away) instead.

## Toolbar icon: single action vs menu

- **Single-action button** (`chrome.action.onClicked`, no `default_popup`): only correct when the
  *entire* extension has exactly one core function. Not Synapse's shape — it's a multi-module
  toolkit, so the icon opens the Popup's module list/menu.
- **Per-module single-action** (`uiParadigm: 'action-button'`, docs/ROADMAP.md §4.3): deferred —
  requires dynamically swapping `chrome.action.setPopup({popup: ''})` per active module, since a
  statically-declared `default_popup` in the manifest swallows every click before
  `onClicked` can fire. Treat as a future per-module opt-in, not a replacement for the list popup.

## Quick placement checklist

1. Does the action need to reference a specific DOM element the user is looking at right now? →
   in-page Shadow-DOM overlay.
2. Will it finish in a few seconds and not need the user to keep looking at the page? → Popup.
3. Does it need a form, a table, unbounded space, or could it run long enough that Popup's
   transient lifetime is a problem? → Dashboard (New Tab).
4. Does it need multi-turn back-and-forth alongside the page, persisting across tab switches? →
   Side Panel (not built yet — flag as a new surface, don't force it into #3).
