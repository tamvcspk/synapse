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
  'env-mismatch', reason?, grantedCapabilities }`, and the service interface (`list`, `activate`,
  `deactivate`, `uploadModule`, `grantCapabilities`, `refresh`).
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
- `chrome-module-registry.ts` — the `ModuleRegistryService` implementation. Merges bundled +
  uploaded entries; bundled Modules auto-grant their declared `needs[]` (trusted, build-time code);
  uploaded Modules start with no grants.
- `user-script-shim.ts` — wraps uploaded source with a header (defines `globalThis.synapse.
  {ai,cache,bus}` proxies that relay via `chrome.runtime.sendMessage`) and a trailer (reads
  `globalThis.__synapseModule`, reports it, auto-runs once, registers a dispatcher).
- `rpc-handler.ts` — background-side authority. Re-checks every `synapse:rpc` call against
  persisted activation + grant state before forwarding to the real Service. **The shim is never
  trusted to self-limit — this file is the actual enforcement point.**
- `storage.ts` — `chrome.storage.local`-backed helpers (activation map, grants map, uploaded
  source map, manifest-report cache). All registry state lives here, not in memory (MV3 background
  can restart at any time — same constraint as `kernel-bootstrap`).

**Popup (`src/adapters/browser-extension/popup/`):** single list view by design — no separate
settings screen. `main.ts` (bootstrap + handlers), `render.ts` (DOM rendering, no framework),
`capability-dialog.ts` (native `<dialog>` consent prompt). Talks to `ChromeModuleRegistryService`
directly — popup has full extension API access, so registry reads/writes don't need messaging;
only the RPC bridge to `USER_SCRIPT`-world code crosses a real isolation boundary.

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
- **New popup feature:** `render.ts`/`main.ts` only — don't introduce a UI framework unless the
  user explicitly asks (current implementation is plain DOM, matching the project's zero-UI-dependency
  footprint).
- **New capability surfaced to uploaded scripts** (beyond `ai`/`cache`/`bus`): extend
  `RpcRequest.service`'s union in `kernel/rpc.ts`, add the proxy in `user-script-shim.ts`'s header,
  and add the corresponding check in `rpc-handler.ts` — all three, or the bridge silently no-ops.
- Authoring docs for people writing uploaded scripts live in `docs/user-scripts.md` +
  `docs/types/synapse-userscript.d.ts` (outside `src/`, excluded from the build by
  `tsconfig.json`'s `"include": ["src"]"`) — update both if the `synapse.*`/`__synapseModule`
  surface changes.
