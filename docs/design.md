# Technical Specification: Synapse (Modular Automation & AI Playground)

## 1. Architectural Vision

**Synapse** is a personal playground for automation and AI experimentation, designed on the principle of **Progressive Complexity**: every task starts as simply as possible and scales in complexity only as necessitated by its own requirements. The framework does not impose a single operating model (e.g., agentic or pipeline) on the entire system—each **Module** explicitly declares the **Capabilities** it requires, and a central **Kernel** is responsible for provisioning the corresponding infrastructure.

Structurally, Synapse follows **Hexagonal Architecture (Ports & Adapters)**: a deterministic, runtime-agnostic **Core** (the `Kernel`, `Module` contracts, execution lifecycles) surrounded by **Ports** (abstract Service interfaces such as `AiService`/`CacheService`/`BusService` — the Core only ever depends on these) and **Adapters** (concrete implementations of those Ports for a specific host runtime). This is what makes "Progressive Complexity" possible without coupling Module logic to any one host API.

**Scope: the Browser Extension is the only runtime, by decision.** Synapse runs entirely as a **Browser Extension (Manifest V3)**—there is no backend/server, and it does not depend on a Node.js runtime during execution. Every Port (AI Adapter, Cache, Bus, Session State) is implemented via native browser APIs (see Section 7). A second host Adapter (VS Code, Electron, plain Node) was considered and **rejected** — Section 8 records the audit and the reasoning. The Hexagonal shape is kept, but for **testability and dependency discipline** (`src/kernel/` and `src/shared/` stay provably free of `chrome.*`, which the test suite can check), never as a portability promise.

This allows for:

* Writing simple tasks (e.g., crawling/synthesizing documentation for an Angular version into a knowledge base) in just a few lines, bypassing all agentic concepts.
* Gradually scaling to complex AI experiments (multi-step agents, RAG, AI vs. rule-based decision-making) by adding capability declarations, without refactoring the foundation.

## 2. Core Concepts

* **Kernel:** A minimalist core that is always present and AI-agnostic. Its sole task: read Module manifests, inject (provision) the necessary Services, and coordinate execution lifecycles (sync or async). It resides in the **background service worker** of the extension (see Section 7).
* **Module:** The smallest unit of work. It can be a pure function (`run(input) -> output`) or a full-fledged Mini-Agent (Decision Engine, AI Adapter, etc.)—depending on the Capability Declaration. It runs in one of the extension's **Execution Contexts** (background / content script / popup) based on its declared capabilities.
* **Capability Declaration (`needs`):** Metadata provided by the Module (`ai`, `cache`, `bus`) telling the Kernel which Services to inject. No declaration = zero overhead, zero dependencies. This is **build-time dependency injection, not permission** — the two used to be one field, and separating them is what Section 3.E is about. `'net'` and `'dom'` were removed from this list (ROADMAP §11.3): they resolved to no Service at all, so declaring them was a silent no-op.
* **Scope Declaration (`scopes`):** What a Module asks to be *allowed to do* on the public `synapseApi` surface — `storage.rw`, `page.dom`, … (`src/kernel/scopes.ts`). Named after purpose/resource, never after a transport. See Section 3.E.
* **Service (= Port, in Hexagonal terms):** Shared infrastructure, initialized only if at least one Module declares a dependency on it. Includes: AI Adapter (+ Throttle/Rate-limit), Shared Cache, Event Bus, and Session State. Each Service is an abstract interface defined by the Core (`AiService`, `CacheService`, `BusService` in `src/kernel/module.ts`); Modules only interact with these interfaces and are agnostic to which concrete Adapter backs them. Today every Service is backed by a `chrome.*`-based Adapter (Section 7) — that's the only Adapter implementation that exists.
* **~~Runtime Env & Environment Guard~~ — removed (Section 8).** `RuntimeEnv`, `Module.supportedEnvs`, and `kernel/environment-guard.ts` no longer exist. With one runtime, the guard could only ever pass; it was a per-Module check on every run that bought nothing. A Module declares *capabilities* and *execution context*, never a host runtime.
* **Context Frame:** A standardized data structure passed through Modules in a Workflow, containing accumulated input/output. It is suitable for both simple sequential pipelines and complex agentic workflows.
* **Workflow:** An explicit, ordered list of Module ids (`{ id, steps: string[] }`, `src/kernel/workflow.ts`) that determines execution order for a sequential chain. Auto-discovery of Modules (§3.D) only answers "what Modules exist," never "in what order" — iteration order from a glob/registry listing must never be relied on for sequencing; only a Workflow's `steps` does that.

## 3. System Architecture

### A. Kernel Layer (Minimalist & Persistent)

* **Manifest Resolver:** Reads the Capability Declaration of every Module before execution.
* **Service Injector:** Initializes/lazy-loads only the Services declared by the Module.
* **Execution Scheduler:** Determines how to run the Module—direct invocation (sync, if the Module does not declare `bus`/async) or via the Event Bus (if the Module requires decoupled/asynchronous coordination). A content-script Module is reached via messaging (`content-scripts/relay.ts`), since background has no DOM; that's decided by where the Module's file lives (§3.D's glob), not by a declared capability. A throwing `run()` is caught and reported via an optional `onFailure` callback (`ModuleFailure { moduleId, error }`) rather than aborting the whole pipeline/bus dispatch — this applies uniformly regardless of Module source (§3.D), since uploaded Modules have no compile-time guarantee of correctness.
* **MV3 Note:** The background service worker is **non-persistent**—it can be terminated and restarted by the browser at any time between events. The Kernel must not hold critical state solely in memory; data requiring persistence across restarts (Session State, Cache) must be read/written via `chrome.storage`.

### B. Module Layer (Complexity determined by the author)

Each Module minimally consists of:

```typescript
Module {
  id: string
  needs?: Capability[]           // Services to inject: ['ai', 'cache', 'bus']
  scopes?: SynapseScopeGrant[]   // Permissions requested: ['storage.rw'], …
  run(input, ctx) -> output      // ctx = { services, api }
}

```

* **Simple Modules** (no `needs`): Pure functions, invoked directly by the Kernel—no Decision Engine, no Bus. Example: `AngularDocAggregator` — fetches, parses, chunks, and writes to a KB file.
* **Complex Modules** (`needs: ['ai', 'bus', 'cache']`): Can be structured as Mini-Agents—deciding autonomously whether to run pure logic or invoke the AI Adapter (via an internal Decision Engine), communicating via the Bus, and utilizing Cache/Session State provided by the Kernel.
* **Modules needing page-JS-level access** (e.g. intercepting `fetch`/`XMLHttpRequest`) are not a
  new Capability — they're a browser-specific *background* Module (`needs: ['bus']`) that
  owns validation/persistence/orchestration, composed with generic MAIN-world infra
  (`src/adapters/browser-extension/utils/`: a dynamic `chrome.scripting` injector, a `CustomEvent`
  channel, a fetch/XHR interception mechanism) that has zero knowledge of the Module's domain
  schema. Such Modules live in `background/modules/<name>/index.ts`, not `src/modules/` — they're
  not portable (they call `chrome.scripting`/`chrome.storage`), even though they never touch the
  page's DOM. See the `main-world-interceptor` and `sdk-layers` skills.

### C. Service Layer (Opt-in, Provisioned on-demand)

* **AI Adapter + Throttle/Rate-Limiter:** Initialized only when a Module declares `ai`. Manages request frequency to the AI Gateway for concurrent modules. Always called from the **background** context—avoiding interference from the host page's CSP.
* **Shared Cache:** Initialized only when a Module declares `cache`. Backing: `chrome.storage.local` for small/structured data, IndexedDB for large payloads (e.g., caching full AI responses).
* **Event Bus:** Initialized only when a Module declares `bus`. Enables decoupled communication (Loose Coupling) between modules—essential for autonomous modules running in parallel, and the mandatory mechanism when a Module resides in a different context than the Kernel (content script ↔ background). Backing: `chrome.runtime.sendMessage`/`onMessage` for discrete messages, `chrome.runtime.connect` (ports) for long-lived/streaming communication. Modules only interact with `BusService.emit/on`.
* **Session State:** Initialized when the Workflow requires "memory" across steps or activations. Backing: `chrome.storage.session` (cleared on browser close, persists through service worker restarts) or `chrome.storage.local` for persistence across browser sessions.

### D. Module Registry Layer (Dynamic Modules, Opt-in via Upload)

Beyond Modules bundled at build time, Synapse supports Modules uploaded at runtime through the extension popup — Tampermonkey-style. This exists because MV3's CSP makes `eval`/dynamic `import()` of arbitrary code impossible in privileged contexts (background/content-script); `chrome.userScripts` (registering code into an isolated `USER_SCRIPT` execution world) is the only sanctioned mechanism for running user-supplied code, so this layer is built around that constraint rather than around a hypothetical filesystem/folder-path model.

* **Module Registry (`ModuleRegistryService`, a Port in `src/kernel/module-registry.ts`):** Unifies two Module sources — `'bundled'` (discovered at build time, see below) and `'uploaded'` (registered at runtime via `chrome.userScripts`). Tracks per-Module activation state, granted scopes, and validation status (`RegistryEntry.status: 'ok' | 'invalid'`) via `chrome.storage` (`src/adapters/browser-extension/module-registry/chrome-module-registry.ts`). Only *uploaded* grants are persisted: a bundled Module's grant is derived from its own build-time `scopes` declaration on every read, keeping first-party permissions out of a store any script could conceivably reach.
* **Bundled-module auto-discovery:** `module-registry/bundled-modules.ts` globs `content-scripts/modules/**/*.module.ts` via Vite's `import.meta.glob(..., { eager: true })`. A Module file placed in that folder is automatically discovered and registered — no manual import/wiring step in `content-scripts/index.ts` is needed. Iteration order here is explicitly not meaningful for execution order (see Workflow, §2).
* **Uploaded modules and the RPC bridge:** An uploaded `.js` file has no build step and therefore no `import` — it declares itself via a global convention, `__synapseModule = { id, scopes, run }` (see `docs/user-scripts.md`), and is registered into an isolated `USER_SCRIPT` world via `chrome.userScripts.register()`. Because that world cannot reach the platform directly, a shim (`module-registry/user-script-shim.ts`) is wrapped around the uploaded source, handing it `ctx.api` (Section 3.E) — a per-script proxy that relays calls to the background via `chrome.runtime.sendMessage` (enabled once by `chrome.userScripts.configureWorld({ messaging: true })`, called from `background/index.ts`). The background's `module-registry/rpc-handler.ts` is the sole authority: it re-checks every call against persisted activation + the approved scope grant before it reaches an implementation — the uploaded script is never trusted to self-limit.
  * **One world, many scripts.** `chrome.userScripts` gives each *page* an isolated `USER_SCRIPT` world, but every registered script shares that one world — there is no per-script sub-isolation. Two consequences, both load-bearing:
    * The shim wraps each script (its own header, the user's source, and its trailer) in a single **synchronous IIFE**. Without it the shim's own top-level `const` collides in the world's shared global lexical environment and the *second* script on a page dies with a redeclaration `SyntaxError` before running — i.e. the platform could only ever run one user script. Pinned by `user-script-shim.test.ts`, which includes a control case proving the collision is real.
    * The API is delivered as **`ctx.api`, never as a global**. A global has one binding per world, so publishing each script's instance under `globalThis.synapseApi` meant the last script evaluated owned the name — and every other script calling through it sent RPC under *that* script's `moduleId`, inheriting its grants. That is the same "identity supplied by the ambient environment rather than the transport" failure the scope model exists to prevent, and it is invisible until a second script exists. The name is left bound to a stub whose methods reject with an explanation, so older scripts fail loudly instead of impersonating a neighbour.
* **Identity:** `chrome.userScripts.register()` requires an id before the uploaded code has ever run, so the extension assigns a canonical UUID at upload time (used for storage, activation, and RPC routing — `RegistryEntry.id`). The script's own self-declared `__synapseModule.id` is only known after its first execution and is surfaced purely as a display label (`RegistryEntry.label`) — it never affects routing or storage keys.
* **Scope consent:** Bundled Modules are trusted build-time code, so their declared `scopes` *are* their grant (derived, not stored). Uploaded Modules always start at `[]` — and since their `scopes` aren't known until their first run reports them, the popup surfaces a "Grant" action once they are; until granted, the RPC handler rejects those specific calls. The two paths are kept structurally separate so an auto-grant branch can never reach an uploaded id. (The script still executes and has ordinary page/DOM access via `chrome.userScripts` regardless — which is precisely why `page.dom` is classified *Disclosed*, see Section 3.E. This is a permission model, not a sandbox.)
* **Graceful fail, not type-check:** Uploaded code has no compile step, so three separate layers catch failure without crashing anything: (1) registration/parse errors surface immediately from `chrome.userScripts.register()`; (2) a hand-rolled shape validator (`kernel/manifest-validator.ts` — no schema library, since the input is a bare `unknown` that hasn't passed through TypeScript) checks `id`/`scopes` once a manifest report arrives; (3) the Scheduler (§3.A) catches a throwing `run()` uniformly for every Module regardless of source.

### E. `synapseApi` and the Scope Model (the public contract)

`synapseApi` (`src/kernel/synapse-api.ts`) is the **only surface with users outside this repo**, and therefore the only one that gets stability guarantees; the Kernel is an internal detail by comparison. One interface, three transports — in-process (`ctx.api`, via `ServiceInjector`), content-script RPC (`content-scripts/rpc-client.ts`), and the uploaded-script shim. A method reachable from one transport but not another is a contract break, not a gap.

* **Three hard constraints**, all consequences of `chrome.runtime.sendMessage`'s structured-clone boundary — violating them yields silent no-ops, not type errors: every method is `async`; **no function-valued parameters** (they arrive as `undefined`); no methods on returned values.
* **Permission by purpose/resource, never by transport.** A script declares what it wants to *do* (`storage.rw`), not which pipe it wants. `bus` can never be a scope: `bus.emit(moduleId, …)` reaches every bundled Module's listener, so "allow bus?" is a question no user can answer. It stays internal plumbing.
* **Enforced vs Disclosed, never merged in the UI.** *Enforced* means `synapseApi` is the only way to do it, so refusal really closes a gate (`storage.rw`). *Disclosed* means the script can do it anyway (`page.dom`, `page.fetch`) — listing it is transparency, and presenting it as a gate would be a consent UI that lies. Classification is per (scope × container): a script hosted in a sandboxed frame has no page DOM, which would make `page.dom` genuinely enforced there.
* **A grant is (action × resource).** Grants persist as `{ scope, match? }` from the start, so adding the resource dimension to a network-touching scope isn't a second data migration. Precedent: Tampermonkey's `@connect`.
* **Storage must be namespaced — the precondition of everything else.** Script-facing storage resolves keys to `script:<moduleId>:<userKey>` inside the service, with `moduleId` taken from the transport, never from an argument. The permission records themselves live in `chrome.storage.local`, so a grantable *unnamespaced* key/value API is a privilege-escalation primitive rather than a convenience — which is exactly what the retired `cache` capability was.
* **A grant is bound to the source it was approved for.** The SHA-256 of the script's source is stored alongside it; a mismatch yields no grant and re-prompts, as Tampermonkey does on script update.
* **Every scope and method carries a human-readable description in the catalog** (`src/kernel/scopes.ts`). The consent UI needs one anyway, which makes that catalog the source the published types are generated from (`docs/types/synapse-userscript.d.ts`, asserted against the generator by `userscript-dts.test.ts`) — hand-written API docs drift within weeks, and stale docs fed to an AI assistant produce confidently wrong code the author cannot diagnose.

## 4. Operational Logic

1. **Declaration:** The Module author defines `needs[]` (Services to inject) and `scopes[]` (permissions requested, §3.E) — the minimum of each.
2. **Loading:** The Kernel reads the manifest of all Modules in the Workflow; the Service Injector initializes only the Services corresponding to declared capabilities.
3. **Execution:**
* If the Module does **not** declare `bus`: The Kernel calls `run()` directly in sequence (output of Module N → input of Module N+1), similar to a standard function pipeline.
* If the Module declares `bus`: The Kernel registers the Module on the Event Bus. The Module receives the Context Frame via events, executes its logic (using its internal Decision Engine if applicable), and emits the result to the Bus.
* If the Module declares `ai`: All AI requests are routed through the AI Adapter (subject to Throttling).


4. **Convergence:** Results are committed to the Context Frame.
5. **Termination:** The Workflow ends when the Context Frame reaches a finalized state or the last Module in the pipeline completes.

## 5. Operating Principles

* **Progressive Complexity:** Infrastructure complexity is directly proportional to Capability Declaration, not a blanket burden. Simple tasks remain simple; complex tasks remain modular.
* **Zero-Cost Opt-in:** No declared capabilities = no dependencies, no runtime overhead, and no agentic concepts to master for simple tasks.
* **Atomic Autonomy (for opt-in `bus` modules):** Modules must not manipulate each other directly. All interactions occur via the Bus.
* **AI-Agnostic:** AI is an explicitly declared capability (`needs: ['ai']`), not a default or hidden behavior.
* **Schema-First (for Bus-enabled modules):** Data transmitted via the Bus must adhere to predefined schemas to ensure debuggability during complex agent interactions.
* **Observability:** The Kernel logs manifest resolution, service provisioning, and every Module execution step in a standardized format.

## 6. Illustrative Examples

**Simple Module** — no Bus, no AI:

```typescript
AngularDocAggregator {
  needs: ['net']
  run(version) {
    // fetch, parse, chunk directly
    return knowledgeBaseChunks
  }
}

```

The Kernel calls `run()` directly. End of process—no agentic overhead.

**Complex Module** — requires AI + coordination:

```typescript
PersonaAutomationAgent {
  needs: ['ai', 'bus', 'cache']
  run(contextFrame, services) {
    if (isSimpleCase(contextFrame)) return ruleBasedLogic(contextFrame)
    return services.ai.ask(contextFrame)   // via throttled AI Adapter
  }
}

```

The Kernel initializes an AI Adapter, Bus, and Cache specifically for this module and registers it on the Bus. Both modules above run in the background service worker (unless `dom` is declared). A module requiring direct page interaction (e.g., `DOM_Extractor`) declares `dom` and runs as a content script, invoked by the Kernel via the Bus/messaging.

## 7. Tech Stack & Execution Contexts (Browser Extension Adapter)

**Platform:** Browser Extension, **Manifest V3**, TypeScript. No proprietary backend/server—all Services rely on native browser APIs. This section describes the **only Adapter there is** (Section 8) — everything in it is browser-extension-specific by design, not by staging.

* **Language & Build:** TypeScript, bundler (e.g., Vite + `@crxjs/vite-plugin`)—producing `background`, `content-scripts`, and `popup`/`options` as distinct entry points. Use `@types/chrome` for type-safe `chrome.*` API access.
* **Project Structure:** Source is split so the Core/Adapter boundary from Section 1 is visible on disk, not just conceptual:

  ```
  src/
    kernel/                              # Core — platform-agnostic, no chrome.* imports
      index.ts, module.ts, service-injector.ts, scheduler.ts
    shared/                              # Global SDK — pure functions, zero side-effects (§9)
    modules/                             # portable Modules (no `dom`, zero chrome.* even transitively)
                                          # — depend only on kernel/module Ports
    adapters/
      browser-extension/                 # the only Adapter implemented today
        utils/                           # Environment SDK — generic infra helpers local to this
                                          # Adapter, no domain knowledge (§9)
        background/
          index.ts                       # Kernel bootstrap: constructs Kernel + Service factories
          modules/<name>/index.ts         # browser-specific, non-portable, non-`dom` Modules —
                                          # e.g. ones orchestrating chrome.scripting/chrome.storage
        content-scripts/index.ts, relay.ts, modules/*.module.ts   # `dom`-declaring Modules
        ui/                               # extension-page UIs, grouped since they share real code
          module-data-sources.ts          # Collection-schema read/write glue, used by both pages
          popup/                          # Module Registry list + on-demand Action results
          dashboard/                      # standalone Tab for Collection-schema Management View
  ```

  `src/adapters/browser-extension/` is the only Adapter directory and (per Section 8) the only one
  there will be — the nesting stays because it's what keeps `src/kernel/` and `src/shared/` honest
  about not importing `chrome.*`, not because a sibling is coming.
* **Build/test scripts:** `npm run build:browser` (aliased by the bare `npm run build`) runs
  `vite build` against `vite.config.ts`, outputting to `dist/browser-extension/`. `npm run
  dev:browser` (aliased by `npm run dev`) runs the same Vite/crx dev flow. `npm test` runs Vitest
  (`vitest.config.ts` — deliberately separate from `vite.config.ts`, whose crx plugin would
  otherwise drive a full extension build on every test run) over `src/**/*.test.ts` in a plain Node
  environment; a test needing a DOM opts in per-file with `// @vitest-environment jsdom` rather than
  changing that default, so a `src/shared/` file that reaches for `document` still fails as it
  should.
* **Execution Contexts:**
* **Background (Service Worker):** Home of the Kernel. Runs all modules *not* declaring `dom` (`net`, `ai`, `cache`, `bus`).
* **Content Script:** Mandatory for modules declaring `dom`. Cannot securely invoke the AI Gateway directly (due to host page CSP)—all `ai`/`net` intensive tasks must be delegated to the background via the Bus.
* **Popup:** Hosts the Module Registry UI (§3.D) — list/toggle/upload/grant. Talks to `ChromeModuleRegistryService` directly (popup pages have full extension API access, so registry reads/writes don't need the Bus); only the RPC bridge to `USER_SCRIPT`-world uploaded Modules crosses a real isolation boundary. No separate settings window — one popup page, showing exactly one view at a time via in-DOM view-swapping (list / action-result / busy / scope-consent — `ui/popup/router.ts`'s `View` union), never multiple windows or native `<dialog>`s. (A Chrome MV3 popup auto-sizes to `document.body`'s normal-flow layout; a `<dialog>`'s top-layer content is excluded from that calculation, so it can render outside the popup's actual on-screen bounds — every popup "modal" is an in-flow view for this reason.) A Collection-schema Module's Management View is not one of this popup's views — see Dashboard below. Rendered with VanJS + Pico.css (`popup.css` layers a few layout rules — narrow fixed width, row/list flex — on top; Pico itself provides button/input/switch/nav theming), same stack as Dashboard — both extension pages under `ui/` share the CSP reasoning below and the vendored Pico bundle (Vite dedupes it into one chunk across both entries).
* **Dashboard:** A standalone Tab (`ui/dashboard/`, opened via `chrome.tabs.create` from the popup's row icon, scoped to one `?moduleId=` at a time) hosting the Management View + Add/Edit form for a Collection-schema Module (docs/ROADMAP.md #2.5) — moved out of the popup entirely so it isn't constrained by Chrome's popup auto-size limits. Built with VanJS + Pico.css: MV3's `extension_pages` CSP has no `unsafe-eval`, which rules out any UI library (e.g. Alpine.js) that evaluates directive strings via `new Function()` at runtime — VanJS's UI is plain TypeScript function calls, compiled once at build time like any other file in `src/`, so there's no runtime eval for the CSP to block. Reads/writes go through the same `ChromeModuleRegistryService` + `CollectionCommand`/Bus path the popup already used (`ui/module-data-sources.ts`), not a new mechanism. A Module opts into this page purely by declaring `uiSchema: {kind: 'collection', ...}` plus `listCollection()` (§9-adjacent — see `Module.listCollection` in `kernel/module.ts`) on itself; nothing here is hardcoded per module.


* **Storage:** `chrome.storage.local` / `chrome.storage.session` for Cache and Session State; IndexedDB for large payloads.
* **Messaging:** `chrome.runtime.sendMessage`/`onMessage` (discrete) or `chrome.runtime.connect` (port, persistent)—the transport layer for the Event Bus when modules reside in different contexts, and for the Module Registry's RPC bridge (§3.D).
* **Permissions:** `storage`; `userScripts` (for uploaded/dynamic Modules, §3.D — requires the user to manually enable "Allow User Scripts" for the extension in `chrome://extensions`, a Chrome UX step outside the code's control).
* **Exclusions:** No Node.js APIs (`fs`, `path`, `process`) in any Module or Service—as the entire runtime operates within the browser.

## 8. A Second Runtime Adapter — Considered and Rejected

Earlier revisions of this section described VS Code / Electron / Node Adapters as *deferred*, and the code carried `RuntimeEnv`, `Module.supportedEnvs`, and an Environment Guard to hold the door open for them. **That direction is now closed** (docs/ROADMAP.md §11.0/§11.1). This section is kept — rather than deleted — so the decision doesn't get silently re-litigated by whoever next notices the Hexagonal shape and asks "where are the other Adapters?"

**What the audit found.** Roughly **0% of the feature surface would port.** Every capability Synapse actually has is a browser capability, not an abstract one:

| Feature | Depends on |
|---|---|
| Network Sniffer (§ROADMAP 4–7) | `chrome.webRequest`, `declarativeNetRequest`, MAIN-world script injection into a real page |
| HTTP Error Mocker (§ROADMAP 2.6) | `chrome.debugger` (CDP), `declarativeNetRequest`, page-world `fetch`/XHR patching |
| Downloader Engine (§ROADMAP 8) | Offscreen Documents, OPFS, `chrome.downloads` |
| Reader Mode (§ROADMAP 1) | A live `Document` from a real web page |
| User scripts (§ROADMAP 11) | `chrome.userScripts` and its USER_SCRIPT world |

There is no `IStoragePort` shaped hole here that a `vscode.ExtensionContext.globalState` could fill and thereby deliver a working product. **The browser is not a host Synapse happens to run in — the browser is Synapse's domain.** A "VS Code Adapter" would not be the same product on another host; it would be a different product sharing a `Module` interface.

**What was removed.** `RuntimeEnv`, `RUNTIME_ENVS`, `Module.supportedEnvs`, `RegistryEntry.supportedEnvs`/`envSupported`, the `'env-mismatch'` module status, and `src/kernel/environment-guard.ts` (with `EnvironmentMismatchError`). An uploaded user script that still declares `supportedEnvs` is not rejected — the field is ignored like any other unknown one.

**What was kept, and why it is NOT the same claim.** The Hexagonal boundary stays: `src/kernel/` and `src/shared/` import no `chrome.*`, Services are injected through `ServiceInjector` rather than imported, and Adapter code lives under `src/adapters/browser-extension/`. The justification is now **testability and dependency discipline**, not portability:

* `src/shared/` is defined by the most restrictive context that must be able to import it — a MAIN-world payload with zero `chrome.*` (§9). That constraint is real and enforced daily, independent of any second host.
* Pure, `chrome.*`-free code is code `npm test` can run in plain Node with no browser harness. That is the whole reason Phase 0's first tests could target `src/shared/` at all.

The difference matters: "keep it clean so it survives a MAIN-world import and a unit test" is a claim this repo can check on every commit. "Keep it clean so it could be ported someday" was a claim nothing could check, and — as the audit above shows — one that was not true anyway. **Do not reintroduce a runtime-env abstraction, and do not justify a design decision by appealing to a future Adapter.**

## 9. Utility/SDK Layering

Beyond Modules and Services, Synapse code that isn't itself a Module (helpers, matchers, formatters) is
split into two layers, so a helper's placement always signals how portable it is:

* **Global SDK (`src/shared/`):** Pure functions only — no DOM, no `chrome.*`, no I/O, no side effects.
  The litmus test isn't "is this reusable across features," it's **"does this survive being imported into
  the most restrictive execution context Synapse has"** — today that's a MAIN-world page-injection
  payload (§3.B, `main-world-interceptor` skill), which has zero `chrome.*` access and doesn't share a JS
  heap with the extension. Importable from `src/kernel/`, `src/modules/`, any Adapter, and MAIN-world
  payloads alike.
* **Environment-Specific SDK (`src/adapters/<env>/utils/`):** Infra helpers that do the "dirty work" for
  one Adapter — DOM injection/registration, storage wiring, messaging bridges. Never imported by
  `src/kernel/` or `src/modules/`; a second Adapter (§8) gets its own sibling `utils/` and shares nothing
  with this one except the `Module`/Service contracts.
* A Global SDK file may still be Adapter-specific in *subject matter* (e.g. `src/shared/http-mock.ts`
  models an HTTP mock rule, which only makes sense for the browser-extension Adapter today) — what makes
  it "Global" is the absence of side effects, not the absence of domain-specificity. Don't create
  `src/shared/` entries speculatively for logic only one call site uses unless that call site is a
  restrictive-environment bundle like the MAIN-world case above; otherwise keep it colocated with the
  Module that needs it (Progressive Complexity, §5).
* **Mechanism vs policy, for deciding a given function's layer, not just a whole file's:** would this
  logic still make sense if the domain type it's next to were swapped for something unrelated? If yes,
  it's a *mechanism* — infra (`utils/`), expressed as a generic hook/callback parameter with no
  knowledge of the caller's schema. If it encodes what the domain type *means* or *what should happen*
  (validation rules, matching/routing decisions, what counts as a valid state), it's *policy* — business,
  owned by a Module or `src/shared/`. Worked example:
  `utils/main-world/network-interceptor.ts`'s `installNetworkInterceptor(evaluate)` is pure mechanism
  (fetch/XHR patch plumbing, would work for any `evaluate` callback); the `evaluate` callback it's given
  — built from `src/shared/http-mock.ts`'s `matchMockConfig`/`buildFakeResponseInit` inside
  `background/modules/http-error-mocker/main-world-payload.ts` — is the policy. When a file mixes both,
  split it: keep the mechanism in `utils/`, move the policy to where the Module composes the two.

---

### Strategic Summary

Synapse is now a **minimalist Hexagonal Core** (`Kernel` + `Module` contracts) surrounded by **on-demand Ports/Services**, currently backed entirely by **one Adapter: the browser extension.** You do not build a "heavy agentic machine" and force every task through it—you build a small core capable of "sprouting" the necessary infrastructure exactly where and when required, based on individual Module declarations. This keeps the playground lightweight enough for "vibe-coding" quick personal tasks, while remaining open-ended for complex AI experiments, without requiring a complete platform refactor. Per Section 8 that Core stays `chrome.*`-free for testability and dependency discipline — not as a down payment on a second host runtime, which has been considered and rejected.