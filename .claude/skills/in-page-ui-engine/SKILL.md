---
name: in-page-ui-engine
description: Build or extend the in-page UI a Module/user script renders onto a host page — the Shadow-DOM host, styling mechanism, reactivity, per-owner surface allocation, and the declarative panel schema behind `synapseApi.ui.*`. Use when adding an on-page widget/panel/overlay, writing the component library, or changing utils/ui-compositor.ts or shared/ui/surface-policy.ts. For *which* surface a feature belongs on (popup vs dashboard vs in-page vs side panel), use `ui-surface-placement` first.
---

# In-page UI engine

`ui-surface-placement` decides **whether** a feature belongs in the page. This skill covers **how**
to render it once that decision is made.

## Guard

**Built (§11 Phase 3):** `utils/ui-compositor.ts` — `createUiSurface(ownerId)` with three fixed
imperative shapes (toast, anchored badge, floating icon), one constructed stylesheet, per-owner
quota, and a DOM-expressed hide valve. Exposed as `synapseApi.ui.*`, which is the only
`transport: 'in-world'` namespace: it takes closures and returns synchronously. Pure decisions live
in `shared/ui/surface-policy.ts` (the only part testable under `environment: 'node'`).

**Not built:** the declarative engine (§11 Phase 6) and per-owner nested shadow roots. Those two are
one job — nested roots exist to keep one script's CSS out of another's, and no script supplies CSS
until the declarative layer does. Don't build either before Phase 3's imperative API has proven the
demand with real consumers.

`utils/floating-widget.ts` is **gone**. If you find a reference to it, it is stale.

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
shared namespace.** The retired `floating-widget.ts` had exactly that — one shared shadow root, one
toast stack, one icon row, keyed by a caller-passed `options.id`, so any caller could `dismiss`
another's widget. Phase 3 replaced it; the lesson is what generalises.

The model: **scripts never receive a node in shared space.** They request a *surface*; Core
allocates and positions it.

- **Identity is assigned by the Platform, never passed by the caller.** `ownerId` comes from the
  composition root (a build-time Module id, or the shim's per-script closure constant), so
  `ui.toast({id:'x'})` becomes the key `<ownerId>:x`. Ask about ownership only through
  `isKeyOf()` — never rebuild the prefix by hand, because a separator mismatch fails *silently*.
- **Quota + deterministic order** instead of first-come-first-served: icons 2/script, toasts 3 plus
  a token bucket, badges 32. A refusal returns `false`; never a silent no-op.
- **Core owns lifecycle.** Deactivating a script, muting it, or navigating removes its surfaces. The
  root gets `pointer-events: none` with `auto` on real widgets, so an empty surface never eats
  clicks meant for the page or another script.
- **The "hide UI" valve is separate from deactivate** (`synapse:ui-muted`, distinct from
  `synapse:activation`). A useful script with annoying UI should be muteable without being disabled.

### The constraint that shapes everything: two worlds, no shared JS state

Bundled Modules run in the ISOLATED content-script world; uploaded scripts run in USER_SCRIPT. They
share **no** registry, counter, or lock — only the document. So anything cross-cutting must be
expressed in the DOM and re-derived from it:

- The host, zones and stylesheet are shared via `#synapse-ui-root`; whichever world arrives first
  creates what is missing and the other fills the gap (`data-styled`).
- **Order comes from sorting owner ids**, never creation order — creation order across two worlds is
  a race by definition. Today that still means uuid order for uploaded scripts, which is stable but
  meaningless to a user. Stable display names now exist (`resolveScriptLabel()`), so the open
  improvement is to sort by label with `ownerId` as tie-break — see docs/ROADMAP.md Open Points.
- The mute flag lives on a `data-hidden-owners` attribute, because USER_SCRIPT world has no
  `chrome.storage` and an async lookup would let a script draw before the flag arrived.

Anything you add that two worlds must agree on has to follow the same rule, or it silently becomes
"whoever ran first wins".

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
