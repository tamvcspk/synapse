---
name: main-world-interceptor
description: Build a Synapse Module that needs page-JS-level access — intercepting window.fetch/XMLHttpRequest, reading a page's in-memory JS state, or anything else only reachable from the page's own (MAIN) execution world, not the extension's ISOLATED content-script world. Use when a module needs to act inside the host page's JS context itself, not just its DOM.
---

# MAIN-World Page Interceptor Pattern

Chrome content scripts run in the **ISOLATED** world: they can read/write the page's DOM, but
`window.fetch`, `window.XMLHttpRequest`, and any other JS global they touch are the *extension's*
copies, not the page's. Patching `window.fetch` there does nothing to requests the page's own JS
makes. Reaching the page's real JS globals requires Chrome's separate **MAIN** world. Full worked
example: `src/adapters/browser-extension/background/modules/http-error-mocker/` — read that before
building a second use of this pattern.

## Where the Module lives — read this before scaffolding

A Module that needs this pattern is **browser-specific but not necessarily `dom`**: it orchestrates
`chrome.scripting` (background-only) to get code into the page, so it can't be a portable
`src/modules/` Module (that folder promises zero `chrome.*`, even transitively — see the
`sdk-layers` skill). It also isn't a `content-scripts/modules/*.module.ts` Module unless it also
needs ISOLATED-world DOM access itself. The business-logic half of this pattern belongs in
**`src/adapters/browser-extension/background/modules/<name>/index.ts`**, `needs: ['bus']`, no `dom`
— see `module-scaffold` for this placement option.

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
4. **`utils/main-world/storage-relay.ts`** — `installStorageToMainWorldRelay<T>(storageKey,
   channelId)`. ISOLATED-world-only (needs `chrome.storage`): forwards a storage key's value (and
   every future `chrome.storage.onChanged` for it) into a MAIN-world channel. This is what feeds
   live config into the MAIN-world payload without the Module needing its own ISOLATED-world
   presence — call it explicitly from `content-scripts/index.ts`, once per (storageKey, channelId)
   pair. Not a Module itself; a single generic infra call is enough for one feature (Progressive
   Complexity) — don't build auto-discovery for this until a second feature needs the same relay.

**Business — owned by the Module, in its own folder:**

- `background/modules/<name>/index.ts` — the Module. Validates commands (delivered over the real
  Bus — see `kernel-bootstrap`'s `chromeRuntimeBus` reference, now wired in `background/index.ts`),
  persists via a colocated storage-CRUD file, and decides *when* to register/unregister the
  MAIN-world script (via `main-world-injector.ts`) based on its own activation state — this
  decision is business policy, never baked into the generic injector.
- `background/modules/<name>/main-world-payload.ts` — the MAIN-world **composition root**. Owned by
  the Module (colocated in its folder) even though it's a physically separate build entry — this is
  where the generic mechanism (`installNetworkInterceptor`, `createMainWorldChannel`) gets wired to
  business logic (matching/response-building functions from `src/shared/`, per `sdk-layers`'s
  litmus test: they must survive being imported into a bundle with zero `chrome.*`). **Zero
  `chrome.*` imports in this file** — it runs in MAIN world, which doesn't have any.
- A small `constants.ts` (storage key, channel id, script id strings) colocated in the same folder,
  imported by `index.ts`, `main-world-payload.ts`, *and* the `content-scripts/index.ts` relay call —
  so the relay wiring doesn't have to import the whole background module (and its `chrome.scripting`
  dependency) just to agree on a string.

## Getting the payload's built path

`chrome.scripting.registerContentScripts`'s `jsPath` wants a path relative to the extension root,
but Vite/crxjs hashes output filenames — you don't know the built filename in source. Use
`@crxjs/vite-plugin`'s dynamic-script resource import:

```ts
import payloadPath from './main-world-payload?script&module';
// payloadPath is a build-time string: the resolved, extension-root-relative output path.
```

This is crxjs's "Auto Web-Accessible Resources" feature (confirmed by reading
`node_modules/@crxjs/vite-plugin/client.d.ts` and `dist/index.mjs`, and by grepping the actual built
`manifest.json`/background chunk in the worked example — the emitted `web_accessible_resources`
entry and the literal resolved path string both check out). Requires
`"@crxjs/vite-plugin/client"` in `tsconfig.json`'s `compilerOptions.types` for the `?script&module`
import to typecheck. Don't try to construct this path manually or guess a filename.

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
