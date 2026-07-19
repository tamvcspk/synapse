---
name: module-registry
description: Explain, extend, or wire into Synapse's Module Registry layer — bundled-module auto-discovery, runtime-uploaded modules via chrome.userScripts (Tampermonkey-style), the RPC bridge that lets uploaded code reach Kernel Services, capability consent, and the popup UI. Matches docs/design.md §3.D. Use when the user wants activate/deactivate for modules, module uploads, a popup for managing modules, or asks how the existing registry/upload feature works.
---

# Module Registry (Dynamic Modules)

This is a layer on top of the baseline Kernel (`kernel-bootstrap` skill) — not a replacement for
it. It exists because Synapse is MV3-only (docs/design.md §7): `eval`/dynamic `import()` of
arbitrary code is blocked by CSP in privileged contexts, so `chrome.userScripts` (an isolated
`USER_SCRIPT` execution world) is the only sanctioned way to run a Module the user supplies at
runtime rather than at build time. Full architecture: docs/design.md §3.D.

## Guard

Check `src/adapters/browser-extension/module-registry/` first. If it already exists, **this is
existing code, not a scaffold target** — read the relevant files before changing anything, and
only touch what the user specifically asked for (e.g. "add a new registry method" doesn't mean
rewriting `chrome-module-registry.ts`). Only build this layer from scratch if the folder is
genuinely missing and the user has asked for activate/deactivate, uploads, or a popup.

## The pieces

**Core (`src/kernel/`, zero `chrome.*` imports):**
- `module-registry.ts` — the `ModuleRegistryService` Port: `RegistryEntry { id, label?, source:
  'bundled'|'uploaded', needs, supportedEnvs, active, envSupported, status: 'ok'|'invalid'|
  'env-mismatch', reason?, grantedCapabilities, uiSchema? }`, and the service interface (`list`,
  `activate`, `deactivate`, `uploadModule`, `grantCapabilities`, `refresh`).
- `ui-schema.ts` — the Declarative UI Schema a `Module` optionally self-declares (`Module.uiSchema`,
  mirrored onto `RegistryEntry.uiSchema`): `UISchema = UICollectionSchema | UIActionSchema`,
  discriminated by `kind` (never a boolean `hasConfig`-style flag) — `'collection'` means a
  persisted list with CRUD (drives the popup's generic Management View), `'action'` means an
  on-demand `run()` trigger with no persisted state (e.g. `reader-mode-converter`). Also
  `CollectionCommand<T>` — the generic `{op:'upsert'|'delete'|'sync', ...}` Bus wire shape any
  collection-schema Module's `run()` should accept, instead of hand-rolling its own command type.
- `manifest-validator.ts` — hand-rolled shape check (no schema lib — the input is `unknown` that
  never passed through TypeScript) for `id`/`needs`/`supportedEnvs` on an uploaded module's
  self-reported manifest.
- `rpc.ts` — message contracts only (`RpcRequest`, `RpcResponse`, `ManifestReport`), no transport.
- `workflow.ts` — `Workflow { id, steps: string[] }` + `resolveWorkflowSteps(workflow, lookup)`.
  This is the *only* thing that should ever determine chained execution order — never glob/registry
  iteration order (see below).

**Adapter (`src/adapters/browser-extension/module-registry/`):**
- `bundled-modules.ts` — `import.meta.glob('../content-scripts/modules/**/*.module.ts', { eager:
  true })`, filtered through `validateModuleManifestShape` as a sanity check. This is what makes
  `module-scaffold` no longer require manual registration for `dom` Modules.
- `chrome-module-registry.ts` — the `ModuleRegistryService` implementation. Builds "bundled"
  entries from **both** `bundled-modules.ts` (`dom` Modules) and `background-modules.ts`
  (browser-specific non-`dom` Modules, e.g. `http-error-mocker`) — a Module needs a `RegistryEntry`
  from either source for the popup's Slide Toggle/Gear icon to apply to it at all — merged with
  uploaded entries; bundled Modules auto-grant their declared `needs[]` (trusted, build-time code)
  and carry over `mod.uiSchema` verbatim; uploaded Modules start with no grants and no `uiSchema`
  support (not built — their manifest isn't known until first run).
- `user-script-shim.ts` — wraps uploaded source with a header (defines `globalThis.synapse.
  {ai,cache,bus}` proxies that relay via `chrome.runtime.sendMessage`) and a trailer (reads
  `globalThis.__synapseModule`, reports it, auto-runs once, registers a dispatcher).
- `rpc-handler.ts` — background-side authority. Re-checks every `synapse:rpc` call against
  persisted activation + grant state before forwarding to the real Service. **The shim is never
  trusted to self-limit — this file is the actual enforcement point.** It's source-agnostic: the
  same handler serves both the uploaded-module shim and the bundled-dom-module RPC client below,
  since both send the same `RpcRequest` shape keyed by `moduleId`.
- `storage.ts` — `chrome.storage.local`-backed helpers (activation map, grants map, uploaded
  source map, manifest-report cache, `isUserScriptsPermissionGranted`/
  `setUserScriptsPermissionGranted`). All registry state lives here, not in memory (MV3 background
  can restart at any time — same constraint as `kernel-bootstrap`).

**Content-script RPC client (`src/adapters/browser-extension/content-scripts/rpc-client.ts`):**
Bundled `dom` Modules get real `ai`/`cache` services, not an empty `ModuleContext` — `relay.ts`
calls `buildDomModuleServices(mod.id, mod.needs)` and passes the result into `mod.run()`. This
mirrors `user-script-shim.ts`'s RPC pattern (same `RpcRequest`/`RpcResponse` contracts, same
`rpc-handler.ts` on the other end) so a bundled dom Module and an uploaded module get equivalent
treatment instead of the bundled path being a dead end. **`bus` is deliberately not proxied here**
— it's pub/sub, and a handler function can't cross `chrome.runtime.sendMessage`'s structured-clone
boundary. A dom Module that truly needs `bus` still has to hand-roll its own messaging inside
`run()` (see `kernel-bootstrap`'s note on this) — don't try to add a generic `bus.on` proxy without
first deciding how a remote handler registration would actually be delivered.

**Popup permission banner:** `background/index.ts` persists the outcome of
`chrome.userScripts.configureWorld(...)` via `storage.ts` (not just `console.warn`), and
`popup/main.ts`'s `load()` reads it and passes `{ userScriptsPermissionGranted }` through
`router.ts` into `views/list-view.ts`'s `renderListView`, which renders a warning banner when it's
`false`. If you change the `configureWorld` call site, keep this persistence — the popup has no
other way to know why uploaded modules silently fail to reach Services.

**Popup (`src/adapters/browser-extension/popup/`):** one popup page, no separate settings window —
but internally a small view-router, not a single static list. `main.ts` (bootstrap + module-level
state `entries`/`view` + all handler functions — business logic, "what happens on each user
action"), `router.ts` (the `View` union — `list` | `management` | `item-form` | `action-result` |
`capability-consent` — plus the `render()` dispatch function: "given state, what's on screen,"
including per-view read-side data fetching via `module-data-sources.ts`), `views/*.ts` (one file
per view, each exporting `render<Name>View(root, props, callbacks): void` — plain callbacks, no
Promises). Talks to `ChromeModuleRegistryService` directly — popup has full extension API access,
so registry reads/writes don't need messaging; only the RPC bridge to `USER_SCRIPT`-world code
crosses a real isolation boundary.

**Never use `<dialog>.showModal()` anywhere in this popup.** A Chrome MV3 popup auto-sizes to
`document.body`'s normal-flow layout — proven to resize correctly by the `list`/`management` view
swap — but a native `<dialog>` renders in the browser's "top layer," which is excluded from that
flow-size calculation, so the popup window's on-screen bounds don't grow for it. The dialog
(including its Close/Cancel button) can end up rendered outside the actual visible/clickable area,
looking like it can't be closed. This project shipped exactly that bug (three separate dialog
files) before replacing all of them with `views/*` in-flow views — any new "modal" UI (confirm
prompts, forms, result viewers) must be a `views/*` entry in the `View` union, never a `<dialog>`.

## Rules — read before extending

- **Identity is the extension's UUID, not the script's self-declared id.**
  `chrome.userScripts.register()` needs an id before the code has ever run; the uploaded script's
  own `__synapseModule.id` is only known after its first execution. Never repurpose the
  self-declared id as a routing/storage key — it's `RegistryEntry.label` only, informational.
- **`rpc-handler.ts` is the only place that grants capability access.** Don't add a shortcut in the
  shim or anywhere else that lets an uploaded Module reach a Service without going through
  `chrome.runtime.sendMessage` → the handler's activation+grant check.
- **Capability consent is gated on Service access, not on script execution.** A registered
  `chrome.userScripts` entry always runs (it has ordinary page/DOM access the moment it's
  registered — same as any userscript manager). The grant only controls whether its `synapse.*`
  calls succeed. Don't try to block execution pending consent; that's not how `chrome.userScripts`
  works and isn't what was built here.
- **Discovery order ≠ execution order.** `bundled-modules.ts`'s glob iteration is meaningless for
  sequencing. If the user wants Modules chained in a specific order, that's a `Workflow` (explicit
  `steps: string[]`), resolved via `resolveWorkflowSteps` and passed to `Kernel.run()` — never
  infer order from discovery.
- **Every `Module.run()` call is wrapped in try/catch by the Scheduler** (`kernel-bootstrap` skill)
  — a throwing Module (bundled or uploaded) reports via `onFailure`, it never crashes the
  pipeline/bus. Don't add a second layer of error handling around `kernel.run()` calls that
  duplicates this.
- **`chrome.userScripts.configureWorld({ messaging: true })` must be called once** (from
  `background/index.ts`, wrapped in try/catch — it throws if the user hasn't enabled "Allow User
  Scripts" for the extension in `chrome://extensions`). Don't let that failure crash the service
  worker; log/surface it instead.

## Extending this layer

- **New registry method:** add to the `ModuleRegistryService` Port first (`kernel/module-registry.ts`),
  then implement in `chrome-module-registry.ts`. Keep the Port `chrome.*`-free.
- **New popup feature:** if it's a new "screen" (a form, a confirm step, a result viewer), add a
  `kind` to `router.ts`'s `View` union and a matching `views/<name>-view.ts` following the
  `render<Name>View(root, props, callbacks): void` convention — never a `<dialog>` (see above). If
  it's a new action on an existing view, extend that view's callbacks + `RouterHandlers` and
  implement the handler in `main.ts`. Don't introduce a UI framework unless the user explicitly
  asks (current implementation is plain DOM, matching the project's zero-UI-dependency footprint).
- **New capability surfaced to uploaded scripts** (beyond `ai`/`cache`/`bus`): extend
  `RpcRequest.service`'s union in `kernel/rpc.ts`, add the proxy in `user-script-shim.ts`'s header,
  and add the corresponding check in `rpc-handler.ts` — all three, or the bridge silently no-ops.
- Authoring docs for people writing uploaded scripts live in `docs/user-scripts.md` +
  `docs/types/synapse-userscript.d.ts` (outside `src/`, excluded from the build by
  `tsconfig.json`'s `"include": ["src"]"`) — update both if the `synapse.*`/`__synapseModule`
  surface changes.
