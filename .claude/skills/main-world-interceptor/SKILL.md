---
name: main-world-interceptor
description: Build a Synapse Module that needs page-JS-level access — intercepting window.fetch/XMLHttpRequest, reading a page's in-memory JS state, or anything else only reachable from the page's own (MAIN) execution world, not the extension's ISOLATED content-script world. Use when a module needs to act inside the host page's JS context itself, not just its DOM.
---

# MAIN-World Page Interceptor Pattern

Chrome content scripts run in the **ISOLATED** world: they can read/write the page's DOM, but
`window.fetch`, `window.XMLHttpRequest`, and any other JS global they touch are the *extension's*
copies, not the page's. Patching `window.fetch` there does nothing to requests the page's own JS
makes. Reaching the page's real JS globals requires Chrome's separate **MAIN** world.

Worked examples in the repo — read one before building a third use of this pattern:
`features/http-mock/` (fetch/XHR interception) and `features/media/` (observe-only MSE/HLS hooks).

## Where the code lives — read this before scaffolding

This pattern always splits across **two execution contexts**, and the filename suffix is what
declares which is which (see `module-scaffold`):

- **The orchestrating Module → `features/<name>/<name>.background.ts`**, `needs: ['bus']`. It
  drives `chrome.scripting`, which exists only in the background. It is browser-specific but *not*
  a content-script Module — it never touches the page's DOM itself.
- **The injected payload → `features/<name>/main-world-payload.page.ts`.** The `.page.ts` suffix
  means MAIN world: **zero `chrome.*`**, no shared JS heap with the extension. It may import from
  `src/shared/` (pure by definition) and from `utils/main-world/*`, nothing else.

The payload is built as a standalone IIFE and referenced by path, not imported by the background
file — check `vite.config.ts` and an existing `main-world-payload.page.ts` for the exact build
incantation before writing a new one; getting the build query wrong fails silently at runtime
(docs/LESSONS.md).

## Why not the obvious approaches

- **`<script>` tag + `textContent` injection (the classic MV2-era trick):** breaks silently on any
  page with a `script-src` CSP that disallows inline scripts. Don't use it — MV3 doesn't need it.
- **Static `content_scripts` entry with `"world": "MAIN"` in `manifest.config.ts`:** works and
  avoids the CSP problem, but runs on *every* page matching `matches`, forever, whether or not the
  feature is active — violating Zero-Cost Opt-in (`docs/design.md` §5).
- **`chrome.scripting.registerContentScripts`/`unregisterContentScripts` with `world: 'MAIN'`
  (what the worked example uses):** dynamically present only while needed, driven by business state.

## The four pieces

**Generic infra — zero domain knowledge, mechanism only (see `sdk-layers`'s mechanism-vs-policy
rule). All under `src/adapters/browser-extension/utils/`:**

1. **`utils/main-world-injector.ts`** — `registerMainWorldScript({id, matches, jsPath, runAt})` /
   `unregisterMainWorldScript(id)` / `isMainWorldScriptRegistered(id)`. Thin wrapper around
   `chrome.scripting`. **Background-only** — `chrome.scripting` doesn't exist in a content script.
   Query `getRegisteredContentScripts` for current state rather than tracking a boolean in memory —
   MV3 service workers restart at any time (`docs/design.md` §3.A), so an in-memory flag drifts.
2. **`utils/main-world/event-channel.ts`** — `createMainWorldChannel<T>(channelId)` →
   `{ dispatch(payload: T), onUpdate(handler) }`. The *only* channel between ISOLATED and MAIN
   world; they share the page's `window`/DOM but not a JS heap. Generic over `T` — plain
   `CustomEvent`, zero `chrome.*`, safe to import from both a content script and a MAIN-world bundle.
3. **`utils/main-world/network-interceptor.ts`** — `installNetworkInterceptor(evaluate)`. Owns
   *only* the fetch/XHR monkey-patch mechanics; `evaluate: (req: {method, url, body}) =>
   InterceptDecision` is supplied by the caller and is where all domain matching/routing logic
   lives. Correctness details that are easy to get wrong (apply here even if you don't reuse this
   exact file):
   - `XMLHttpRequest.prototype.status`/`statusText`/`responseText`/`response` are **getter-only
     accessors** — direct assignment (`xhr.status = 200`) silently no-ops or throws. Shadow them
     per-instance: `Object.defineProperty(xhrInstance, 'status', { value: 200, configurable: true })`.
   - Fire `readystatechange`, `load`, `loadend` in that order — some libraries only listen for one.
   - For `fetch`, construct a real `new Response(bodyText, { status, statusText })` — callers may
     call `.json()`/`.text()`/check `.ok`.
   - Always delegate to the original `fetch`/`open`/`send` when `evaluate` returns "don't
     intercept" — never assume every request on the page should be touched.
   - Resolve the captured URL to absolute (`new URL(url, window.location.href).href`) before
     handing it to `evaluate` — a page calling `fetch('/api/x')` with a bare relative path is
     common, and a pattern/URL matcher comparing that against an absolute pattern will never match
     otherwise. Do this here (this file already has `window`), not in the pure matching function.
   - Don't match endpoint patterns with a plain substring `url.includes(pattern)` — it silently
     treats a documented `*` wildcard as a literal asterisk, and forces users to escape `?`/`.` in
     real URLs. Compile the pattern into a `RegExp` (escape everything except `*`, turn `*` into
     `.*`) instead.
4. **`utils/main-world/storage-relay.ts`** — `installStorageToMainWorldRelay<T>(storageKey,
   channelId)`. ISOLATED-world-only (needs `chrome.storage`): forwards a storage key's value (and
   every future `chrome.storage.onChanged` for it) into a MAIN-world channel. This is what feeds
   live config into the MAIN-world payload without the Module needing its own ISOLATED-world
   presence — call it explicitly from `content-scripts/index.ts`, once per (storageKey, channelId)
   pair. Not a Module itself; a single generic infra call is enough for one feature (Progressive
   Complexity) — don't build auto-discovery for this until a second feature needs the same relay.

**Business — owned by the Module, in its own folder:**

- `features/<name>/<name>.background.ts` — the Module. Validates commands (delivered over the real
  Bus), persists via a colocated `*-store.background.ts`, and decides *when* to register/unregister
  the MAIN-world script (via `main-world-injector.ts`) based on its own activation state — this
  decision is business policy, never baked into the generic injector.
- `features/<name>/main-world-payload.page.ts` — the MAIN-world **composition root**. Colocated with
  the feature even though it's a physically separate build entry. This is where generic mechanism
  (`installNetworkInterceptor`, `createMainWorldChannel`) gets wired to business logic (matching /
  response-building functions from `src/shared/`, per `sdk-layers`'s litmus test: they must survive
  being imported into a bundle with zero `chrome.*`). **Zero `chrome.*` imports** — the `.page.ts`
  suffix exists to make that violation obvious in review.
- A small `constants.ts` (storage key, channel id, script id strings) colocated in the same feature
  folder — **no suffix, because it is read from three contexts at once**: the background Module, the
  MAIN-world payload, and the `content-scripts/index.ts` relay. That way the relay doesn't have to
  import the whole background Module (and its `chrome.scripting` dependency) just to agree on a
  string.

## Getting the payload's built path

`chrome.scripting.registerContentScripts`'s `jsPath` wants a path relative to the extension root,
but Vite/crxjs hashes output filenames — you don't know the built filename in source. Use
`@crxjs/vite-plugin`'s dynamic-script resource import, with **`&iife`, not `&module`**:

```ts
import payloadPath from './main-world-payload?script&iife';
// payloadPath is a build-time string: the resolved, extension-root-relative output path.
```

**This was previously documented (and built) as `?script&module` — that is wrong and was confirmed
broken in practice, not just in theory.** `chrome.scripting`'s `js` array always injects as a
*classic* script, never a module. `?script&module` tags the file as crxjs's `"module"` script type,
which (per `finalizeBuildContentScripts` in `@crxjs/vite-plugin/dist/index.mjs`) is left completely
unwrapped — a raw ESM chunk with real top-level `import` statements to whatever other chunks it
shares with the rest of the build (e.g. a `shared/`-SDK file also used by the background bundle).
Injected as a classic script, that throws `SyntaxError: Cannot use import statement outside a
module` immediately, before a single line of the payload runs — silently, with no error surfaced
anywhere reachable from the page or the extension's own consoles. `?script&iife` instead resolves
to crxjs's dedicated IIFE bundler (`collectIifeEntries`/`bundleIife`), which inlines every
dependency into one self-contained file with zero `import` statements — the only variant that
actually executes when injected this way. If a symptom looks like "the registered script produces
literally zero observable side effects, not even a top-of-file `console.log`, despite
`chrome.scripting.getRegisteredContentScripts()` showing it correctly registered" — check this
first, by grepping the built output file for the string `import{` before looking anywhere else.

Requires `"@crxjs/vite-plugin/client"` in `tsconfig.json`'s `compilerOptions.types` for the
`?script&iife` import to typecheck. Don't try to construct this path manually or guess a filename.

## Manifest permission this pattern needs beyond `scripting`

`chrome.scripting.registerContentScripts`/`updateContentScripts` needs its own host permission
grant to actually inject anything — a static `content_scripts.matches` entry does **not** satisfy
this for the dynamic API, even though both show the same install-time permission warning to the
user. Add `host_permissions: ['<all_urls>']` (or your narrower match list) to
`manifest.config.ts`. Without it, `registerContentScripts` resolves its promise with no error at
all, `getRegisteredContentScripts()` shows a perfectly correct-looking entry, and the script still
never runs on any page — the single hardest-to-diagnose failure mode in this whole pattern, since
every other signal says "this worked." If a from-scratch raw `chrome.scripting.registerContentScripts`
call (bypassing the whole Module/Bus system, registering a trivial one-line test script) still
produces zero observable effect on any page despite resolving cleanly, suspect this before anything
in this project's own code.

## The ISOLATED-world relay's `run_at` must not lag the MAIN-world script's

`storage-relay.ts`'s `installStorageToMainWorldRelay` needs to have dispatched at least once before
the page's own scripts start firing requests the interceptor is supposed to catch. If the static
`content_scripts` entry (which hosts the relay call, in `content-scripts/index.ts`) is left at its
default `run_at` (`document_idle`) while the dynamically-registered MAIN-world script uses
`document_start` (as it should, to patch `fetch`/`XMLHttpRequest` before the page's own code runs),
there's a real window — long enough on a request-heavy SPA (GitHub's own early hovercard/analytics
calls were enough to demonstrate it) — where the MAIN-world payload has already patched `fetch` but
`configs` is still `[]`, so nothing matches. Set `run_at: 'document_start'` on the static
`content_scripts` entry too.

## Wiring a command through the real Bus

Popup (or any other caller outside the Kernel) can trigger the Module without holding a
`BusService` instance — `chromeRuntimeBus`'s wire format is just
`chrome.runtime.sendMessage({ event: moduleId, payload })`. `chrome.runtime.sendMessage` doesn't
wait for the handler to finish, so don't refetch/rerender immediately after sending — subscribe to
`chrome.storage.onChanged` for the same key the Module persists to, and refresh reactively once the
write actually lands.

## Don't build this speculatively

Four new infra files + a background Module + a manifest permission is real complexity — only reach
for it when a Module genuinely needs to act inside the page's own JS context (network interception,
reading page JS state). A Module that only needs to *read* rendered DOM content is a plain `dom`
Module (`module-scaffold`) with no MAIN-world involvement at all.

## See also

`docs/LESSONS.md` has the full gotcha list this skill's own sections draw from (`?script&module` vs
`?script&iife`, `host_permissions` for dynamic MAIN-world registration, separate DevTools consoles
per world) plus adjacent runtime gotchas outside this skill's scope — `chrome.sidePanel`, Offscreen
Document's `chrome.runtime`-only restriction, DNR `tabIds`/`TAB_ID_NONE` scoping. Check it before
assuming a new silent-failure symptom is unprecedented.
