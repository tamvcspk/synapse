---
name: in-page-ui-engine
description: Build or extend the in-page UI a Module/user script renders onto a host page — the Shadow-DOM host, styling mechanism, reactivity, and the declarative panel schema behind `synapseApi.ui.*`. Use when adding an on-page widget/panel/overlay, writing the component library, or changing utils/floating-widget.ts. For *which* surface a feature belongs on (popup vs dashboard vs in-page vs side panel), use `ui-surface-placement` first.
---

# In-page UI engine

`ui-surface-placement` decides **whether** a feature belongs in the page. This skill covers **how**
to render it once that decision is made.

## Guard

As of docs/ROADMAP.md §11 the declarative engine is **planned, not built**. What exists:
`utils/floating-widget.ts` — an imperative Shadow-DOM host with three fixed shapes (toast card,
anchored badge, floating icon), styled by direct CSSOM assignment. §11 Phase 4 wraps it as
`synapseApi.ui.*`; Phase 6 adds the declarative layer. Don't build the declarative engine before
the imperative wrapper has a real consumer.

## Where the engine runs — decided

**The render engine runs in the same world as the code that declares the UI** (the user script's
own USER_SCRIPT world), not in the extension's ISOLATED world.

Rationale, already settled — do not re-litigate:
- Putting the engine across a message boundary forces every UI declaration through structured
  clone, which **kills closures**: `onClick: () => count++` cannot cross. Only string-keyed action
  dispatch survives. That permanently rules out template-literal authoring.
- Every state change would become a round trip — visible jank on anything interactive.
- It buys no safety: a user script already has full DOM access. The engine is not a sandbox.

**Core still owns**: the Shadow host element, portal/insertion point, lifecycle (teardown on
navigation/deactivate), the component library, and the stylesheet. A script that misbehaves loses
its host; it never gets to own the mount point.

## Pick the container first

Contention differs by container, so allocation strategy does too (docs/ROADMAP.md §11.4/§11.8):

| | **A · Floating (Shadow DOM on the page)** | **B · Own page / sidebar tab (sandboxed iframe)** |
|---|---|---|
| Closures | ✅ | ✅ (inside its own frame) |
| Isolation | shadow root — CSS separated, **events still bleed** | separate document — CSS + events + JS fully separated |
| Host page DOM | ✅ direct | ❌ none |
| `chrome.*` | none (RPC via shim) | none (sandbox origin is `null`) → postMessage → parent → background |
| Space contention | needs a compositor | none — one frame each |

**A script cannot run inside an extension page.** MV3 CSP blocks `eval`/dynamic `import` in
privileged contexts and `chrome.userScripts` only matches web-page URLs, so a sandboxed iframe
(`manifest.sandbox.pages` + `content_security_policy.sandbox`) is the only sanctioned host. The
manifest has no `sandbox` entry today — adding one is Phase 7 work, not a small change.

**Rule worth remembering: the container decides whether `page.dom` is enforceable.** In A the script
already has the DOM, so `page.dom` can only be *disclosed*. In B it has no page DOM at all and must
go through `page.*`, so `page.dom` becomes a **real gate**. Prefer B for any script that doesn't
genuinely need to attach to the page.

## Multi-script contention — Platform is a compositor

Independent scripts sharing one surface will overwrite each other, fight for space, and break
layout. **Same root cause as the `cache` privilege-escalation hole: caller-supplied identity in a
shared namespace.** `floating-widget.ts` has exactly that today — one shared shadow root, one toast
stack, one icon row, keyed by a caller-passed `options.id`, so any caller can `dismiss` another's
widget.

The model: **scripts never receive a node in shared space.** They request a *surface*; Core
allocates and positions it.

- **Identity is assigned by the Platform, never passed by the caller.** `moduleId` comes from the
  transport. `ui.toast({id:'x'})` → internal key `<moduleId>:x`. The API only ever returns the
  caller's own surfaces, so one script cannot address another's.
- **One shadow root per script**, not one shared. Buys CSS separation between scripts, atomic
  teardown of a script's whole UI, harmless id collisions, and a per-surface stacking context so
  z-order is Core's decision rather than "whoever rendered first".
- **Quota + deterministic order** instead of first-come-first-served: persistent surfaces (icon,
  panel) default to 1 per script with a hard cap; toasts are queued and rate-limited per script;
  ordering follows script name or user configuration, **never creation order**.
- **Core owns lifecycle.** A surface is bound to `(moduleId, tabId, page load)`; deactivating or
  deleting a script, or navigating, removes its host. Container gets `pointer-events: none` with
  `auto` on children so an empty surface never eats clicks meant for the page or another surface.
- **Ship a per-script "hide UI" toggle** separate from deactivate. A useful script with annoying UI
  should be muteable without being disabled.

**Do not promise event isolation for container A.** A script can `document.addEventListener('click')`
and observe clicks in another script's UI; that cannot be prevented, for the same reason `page.dom`
is disclosed-only. Core guarantees only that compositor events don't leak and that no surface
covers another's hit-testing. Container B does isolate events — because it's a separate document,
not because of anything the engine does.

## Styling — `adoptedStyleSheets`

Verified against real Chrome 150 (docs/LESSONS.md, "Chrome extension UI injection"):

```js
const sheet = new CSSStyleSheet();
sheet.replaceSync(css);              // real CSS text: :hover, media queries, pseudo-elements
shadowRoot.adoptedStyleSheets = [sheet];
```

- **Not subject to the host page's `style-src` CSP** — works identically in MAIN and ISOLATED
  worlds, including under `style-src 'self'`.
- **`<style>` elements and `style=""` attribute strings ARE subject to it** and get silently
  dropped on strict sites. Never use either for in-page UI.
- Direct CSSOM (`el.style.x = …`) also works and remains a valid fallback, but it cannot express
  `:hover`/media queries — that limitation is why the component library uses constructed sheets.
- **One sheet, many roots.** Build the component library's sheet once and adopt it into every
  widget's shadow root rather than re-parsing CSS per widget.
- **`@import` is ignored inside a constructed sheet** — inline everything.

Shadow root stays `mode: 'open'`. Closed mode adds no real protection (the host element is still
reachable and removable by page JS) and blocks your own debugging.

## Declarative schema

Reuse the vocabulary already in `src/kernel/ui-schema.ts` (`UIFieldDef`, `showWhen`, `rowActions`,
the `kind` discriminator) rather than inventing a second DSL. That file today only describes
**form/table** UI rendered on extension pages; extending it to free-form in-page layout is the
Phase 6 job. Two authoring modes are both viable once the engine runs in-world:

- **Data schema** (`{tag, children, onClick}` or field-list) — serializable, inspectable,
  persistable. Prefer it for anything Core may need to store, validate, or re-render from storage.
- **Template literal** (`html\`…\``) with closures — better ergonomics for interactive widgets.

Whichever is added first, keep `emit('ACTION_ID')` + an `actions` map available: string-keyed
dispatch is the only form that also survives being sent somewhere else later.

## Never

- **Never `<style>` or `style=""`.** See above — silent failure, hard to diagnose.
- **Never bundle Pico.css/VanJS into a content script.** Those are extension-page-only tools
  (docs/design.md §7). In-page UI ships its own minimal CSS through a constructed sheet.
- **Never render unless triggered**, and never alter host-page layout. Guest rules.
- **Never navigate to a `chrome-extension://` URL from page context** — blocked unless the target
  is in `web_accessible_resources`, which over-exposes privileged pages. Use a button →
  `chrome.runtime.sendMessage` → background `chrome.tabs.create`.

## See also

- `docs/LESSONS.md` — "Chrome extension UI injection vào trang bất kỳ" (CSP, `web_accessible_resources`,
  MAIN-world registration) and "Rendering không-diff (VanJS-style)".
- `userscript-api` skill — the `ui.render` scope this engine sits behind.
