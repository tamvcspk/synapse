# Technical Specification: Synapse (Modular Automation & AI Playground)

## 1. Architectural Vision

**Synapse** is a personal playground for automation and AI experimentation, designed on the principle of **Progressive Complexity**: every task starts as simply as possible and scales in complexity only as necessitated by its own requirements. The framework does not impose a single operating model (e.g., agentic or pipeline) on the entire system—each **Module** explicitly declares the **Capabilities** it requires, and a central **Kernel** is responsible for provisioning the corresponding infrastructure.

Structurally, Synapse follows **Hexagonal Architecture (Ports & Adapters)**: a deterministic, runtime-agnostic **Core** (the `Kernel`, `Module` contracts, execution lifecycles) surrounded by **Ports** (abstract Service interfaces such as `AiService`/`CacheService`/`BusService` — the Core only ever depends on these) and **Adapters** (concrete implementations of those Ports for a specific host runtime). This is what makes "Progressive Complexity" possible without coupling Module logic to any one host API.

**Current scope: only the Browser Extension Adapter is implemented.** Synapse runs entirely as a **Browser Extension (Manifest V3)**—there is no backend/server, and it does not depend on a Node.js runtime during execution. Every Port (AI Adapter, Cache, Bus, Session State) is implemented via native browser APIs (see Section 7). The Hexagonal shape is deliberately designed to admit other host Adapters later (VS Code, Electron, plain Node) — Section 8 documents that direction — but **no other Adapter exists yet, and none should be built without an explicit request.** Treat every other `RuntimeEnv` value as a reserved placeholder, not a target.

This allows for:

* Writing simple tasks (e.g., crawling/synthesizing documentation for an Angular version into a knowledge base) in just a few lines, bypassing all agentic concepts.
* Gradually scaling to complex AI experiments (multi-step agents, RAG, AI vs. rule-based decision-making) by adding capability declarations, without refactoring the foundation.

## 2. Core Concepts

* **Kernel:** A minimalist core that is always present and AI-agnostic. Its sole task: read Module manifests, inject (provision) the necessary Services, and coordinate execution lifecycles (sync or async). It resides in the **background service worker** of the extension (see Section 7).
* **Module:** The smallest unit of work. It can be a pure function (`run(input) -> output`) or a full-fledged Mini-Agent (Decision Engine, AI Adapter, etc.)—depending on the Capability Declaration. It runs in one of the extension's **Execution Contexts** (background / content script / popup) based on its declared capabilities.
* **Capability Declaration:** Metadata provided by the Module (e.g., `ai`, `net`, `cache`, `bus`, `dom`) to inform the Kernel of the Services it requires. No declaration = zero overhead, zero dependencies.
* **Service (= Port, in Hexagonal terms):** Shared infrastructure, initialized only if at least one Module declares a dependency on it. Includes: AI Adapter (+ Throttle/Rate-limit), Shared Cache, Event Bus, and Session State. Each Service is an abstract interface defined by the Core (`AiService`, `CacheService`, `BusService` in `src/kernel/module.ts`); Modules only interact with these interfaces and are agnostic to which concrete Adapter backs them. Today every Service is backed by a `chrome.*`-based Adapter (Section 7) — that's the only Adapter implementation that exists.
* **Runtime Env & Environment Guard:** Each Module optionally declares `supportedEnvs: RuntimeEnv[]` (see `src/kernel/module.ts`), the set of host runtimes it may execute in. Before scheduling a Module, the Kernel's Environment Guard (`src/kernel/environment-guard.ts`) checks the Module's `supportedEnvs` against the Kernel's active `currentEnv` and throws `EnvironmentMismatchError` on mismatch. A Module that omits `supportedEnvs` implicitly targets `['browser-extension']`, since that is the only Adapter Synapse ships today.
* **Context Frame:** A standardized data structure passed through Modules in a Workflow, containing accumulated input/output. It is suitable for both simple sequential pipelines and complex agentic workflows.
* **Workflow:** An explicit, ordered list of Module ids (`{ id, steps: string[] }`, `src/kernel/workflow.ts`) that determines execution order for a sequential chain. Auto-discovery of Modules (§3.D) only answers "what Modules exist," never "in what order" — iteration order from a glob/registry listing must never be relied on for sequencing; only a Workflow's `steps` does that.

## 3. System Architecture

### A. Kernel Layer (Minimalist & Persistent)

* **Manifest Resolver:** Reads the Capability Declaration of every Module before execution.
* **Environment Guard:** Runs before the Manifest Resolver hands a Module to the Scheduler. Compares the Module's `supportedEnvs` against the Kernel's `currentEnv` (defaults to `'browser-extension'`); on mismatch it aborts that Module's execution with `EnvironmentMismatchError` rather than letting it reach a Service Injector/Adapter it wasn't written for. This is what keeps a future non-browser Module from silently breaking when Synapse boots inside an Adapter it doesn't support — see Section 8.
* **Service Injector:** Initializes/lazy-loads only the Services declared by the Module.
* **Execution Scheduler:** Determines how to run the Module—direct invocation (sync, if the Module does not declare `bus`/async) or via the Event Bus (if the Module requires decoupled/asynchronous coordination). If a Module declares `dom`, the Scheduler routes calls via messaging to the content script (as background lacks DOM access). A throwing `run()` is caught and reported via an optional `onFailure` callback (`ModuleFailure { moduleId, error }`) rather than aborting the whole pipeline/bus dispatch — this applies uniformly regardless of Module source (§3.D), since uploaded Modules have no compile-time guarantee of correctness.
* **MV3 Note:** The background service worker is **non-persistent**—it can be terminated and restarted by the browser at any time between events. The Kernel must not hold critical state solely in memory; data requiring persistence across restarts (Session State, Cache) must be read/written via `chrome.storage`.

### B. Module Layer (Complexity determined by the author)

Each Module minimally consists of:

```typescript
Module {
  id: string
  needs?: Capability[]        // e.g., ['net'], ['ai', 'cache', 'bus']
  supportedEnvs?: RuntimeEnv[] // defaults to ['browser-extension'] — see §2 Runtime Env & Environment Guard
  run(input, ctx) -> output
}

```

* **Simple Modules** (`needs: ['net']` or empty): Pure functions, invoked directly by the Kernel—no Decision Engine, no Bus. Example: `AngularDocAggregator` — fetches, parses, chunks, and writes to a KB file.
* **Complex Modules** (`needs: ['ai', 'bus', 'cache']`): Can be structured as Mini-Agents—deciding autonomously whether to run pure logic or invoke the AI Adapter (via an internal Decision Engine), communicating via the Bus, and utilizing Cache/Session State provided by the Kernel.

### C. Service Layer (Opt-in, Provisioned on-demand)

* **AI Adapter + Throttle/Rate-Limiter:** Initialized only when a Module declares `ai`. Manages request frequency to the AI Gateway for concurrent modules. Always called from the **background** context—avoiding interference from the host page's CSP.
* **Shared Cache:** Initialized only when a Module declares `cache`. Backing: `chrome.storage.local` for small/structured data, IndexedDB for large payloads (e.g., caching full AI responses).
* **Event Bus:** Initialized only when a Module declares `bus`. Enables decoupled communication (Loose Coupling) between modules—essential for autonomous modules running in parallel, and the mandatory mechanism when a Module resides in a different context than the Kernel (content script ↔ background). Backing: `chrome.runtime.sendMessage`/`onMessage` for discrete messages, `chrome.runtime.connect` (ports) for long-lived/streaming communication. Modules only interact with `BusService.emit/on`.
* **Session State:** Initialized when the Workflow requires "memory" across steps or activations. Backing: `chrome.storage.session` (cleared on browser close, persists through service worker restarts) or `chrome.storage.local` for persistence across browser sessions.

### D. Module Registry Layer (Dynamic Modules, Opt-in via Upload)

Beyond Modules bundled at build time, Synapse supports Modules uploaded at runtime through the extension popup — Tampermonkey-style. This exists because MV3's CSP makes `eval`/dynamic `import()` of arbitrary code impossible in privileged contexts (background/content-script); `chrome.userScripts` (registering code into an isolated `USER_SCRIPT` execution world) is the only sanctioned mechanism for running user-supplied code, so this layer is built around that constraint rather than around a hypothetical filesystem/folder-path model.

* **Module Registry (`ModuleRegistryService`, a Port in `src/kernel/module-registry.ts`):** Unifies two Module sources — `'bundled'` (discovered at build time, see below) and `'uploaded'` (registered at runtime via `chrome.userScripts`). Tracks per-Module activation state, granted capabilities, and validation status (`RegistryEntry.status: 'ok' | 'invalid' | 'env-mismatch'`), all persisted via `chrome.storage` (`src/adapters/browser-extension/module-registry/chrome-module-registry.ts`).
* **Bundled-module auto-discovery:** `module-registry/bundled-modules.ts` globs `content-scripts/modules/**/*.module.ts` via Vite's `import.meta.glob(..., { eager: true })`. A Module file placed in that folder is automatically discovered and registered — no manual import/wiring step in `content-scripts/index.ts` is needed. Iteration order here is explicitly not meaningful for execution order (see Workflow, §2).
* **Uploaded modules and the RPC bridge:** An uploaded `.js` file has no build step and therefore no `import` — it declares itself via a global convention, `globalThis.__synapseModule = { id, needs, supportedEnvs, run }` (see `docs/user-scripts.md`), and is registered into an isolated `USER_SCRIPT` world via `chrome.userScripts.register()`. Because that world cannot reach Kernel Services directly, a shim (`module-registry/user-script-shim.ts`) is wrapped around the uploaded source, exposing `globalThis.synapse.{ai,cache,bus}` proxies that relay calls to the background via `chrome.runtime.sendMessage` (enabled once by `chrome.userScripts.configureWorld({ messaging: true })`, called from `background/index.ts`). The background's `module-registry/rpc-handler.ts` is the sole authority: it re-checks every call against persisted activation + capability-grant state before forwarding to the real Service — the uploaded script is never trusted to self-limit.
* **Identity:** `chrome.userScripts.register()` requires an id before the uploaded code has ever run, so the extension assigns a canonical UUID at upload time (used for storage, activation, and RPC routing — `RegistryEntry.id`). The script's own self-declared `__synapseModule.id` is only known after its first execution and is surfaced purely as a display label (`RegistryEntry.label`) — it never affects routing or storage keys.
* **Capability consent:** Bundled Modules are trusted build-time code and auto-grant their declared `needs[]` the first time they're discovered. Uploaded Modules start with no granted capabilities — since their `needs[]` isn't known until their first run reports it, the popup surfaces a "Grant" action once that's known, and until granted, the RPC handler rejects those specific `synapse.*` calls. (The Module itself still executes and has ordinary page/DOM access via `chrome.userScripts` regardless — the grant only gates access to Kernel Services, matching how Tampermonkey-style user scripts inherently get page access on registration; it is not a general sandboxing mechanism.)
* **Graceful fail, not type-check:** Uploaded code has no compile step, so three separate layers catch failure without crashing anything: (1) registration/parse errors surface immediately from `chrome.userScripts.register()`; (2) a hand-rolled shape validator (`kernel/manifest-validator.ts` — no schema library, since the input is a bare `unknown` that hasn't passed through TypeScript) checks `id`/`needs`/`supportedEnvs` once a manifest report arrives; (3) the Scheduler (§3.A) catches a throwing `run()` uniformly for every Module regardless of source.

## 4. Operational Logic

1. **Declaration:** The Module author defines `needs[]`—the minimum capabilities required.
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

**Platform:** Browser Extension, **Manifest V3**, TypeScript. No proprietary backend/server—all Services rely on native browser APIs. This section describes the **only Adapter implemented today** — everything in it is specific to the browser-extension `RuntimeEnv` and does not apply if/when another Adapter is ever built (Section 8).

* **Language & Build:** TypeScript, bundler (e.g., Vite + `@crxjs/vite-plugin`)—producing `background`, `content-scripts`, and `popup`/`options` as distinct entry points. Use `@types/chrome` for type-safe `chrome.*` API access.
* **Project Structure:** Source is split so the Core/Adapter boundary from Section 1 is visible on disk, not just conceptual:

  ```
  src/
    kernel/                              # Core — platform-agnostic, no chrome.* imports
      index.ts, module.ts, service-injector.ts, scheduler.ts, environment-guard.ts
    modules/                             # portable Modules (no `dom`) — depend only on kernel/module Ports
    adapters/
      browser-extension/                 # the only Adapter implemented today
        background/index.ts              # Kernel bootstrap: constructs Kernel + Service factories
        content-scripts/index.ts, relay.ts, modules/*.module.ts   # `dom`-declaring Modules
  ```

  A future Adapter (Section 8) would add a sibling `src/adapters/<env>/`, never touch `src/kernel/`,
  and only touch `src/modules/` if a Module explicitly opts into that `RuntimeEnv`.
* **Build scripts are per-Adapter:** `npm run build:browser` (aliased by the bare `npm run build`,
  since it's the only Adapter) runs `vite build` against `vite.config.ts`, which outputs to
  `dist/browser-extension/` — scoped so a future `build:vscode`/`build:electron` can output to its
  own `dist/<env>/` without collision. `npm run dev:browser` (aliased by `npm run dev`) runs the
  same Vite/crx dev flow. Neither alias should silently start meaning "build everything" once a
  second Adapter exists — at that point `build`/`dev` should either be dropped or turned into an
  explicit multi-target script, not left ambiguous.
* **Execution Contexts:**
* **Background (Service Worker):** Home of the Kernel. Runs all modules *not* declaring `dom` (`net`, `ai`, `cache`, `bus`).
* **Content Script:** Mandatory for modules declaring `dom`. Cannot securely invoke the AI Gateway directly (due to host page CSP)—all `ai`/`net` intensive tasks must be delegated to the background via the Bus.
* **Popup:** Hosts the Module Registry UI (§3.D) — list/toggle/upload/grant. Talks to `ChromeModuleRegistryService` directly (popup pages have full extension API access, so registry reads/writes don't need the Bus); only the RPC bridge to `USER_SCRIPT`-world uploaded Modules crosses a real isolation boundary. No separate settings screen — a single list view by design.


* **Storage:** `chrome.storage.local` / `chrome.storage.session` for Cache and Session State; IndexedDB for large payloads.
* **Messaging:** `chrome.runtime.sendMessage`/`onMessage` (discrete) or `chrome.runtime.connect` (port, persistent)—the transport layer for the Event Bus when modules reside in different contexts, and for the Module Registry's RPC bridge (§3.D).
* **Permissions:** `storage`; `userScripts` (for uploaded/dynamic Modules, §3.D — requires the user to manually enable "Allow User Scripts" for the extension in `chrome://extensions`, a Chrome UX step outside the code's control).
* **Exclusions:** No Node.js APIs (`fs`, `path`, `process`) in any Module or Service—as the entire runtime operates within the browser.

## 8. Future Runtime Adapters (Not Yet Implemented)

This section is a **roadmap, not a build spec.** It records the intended shape of additional Adapters so the Core stays designed to admit them, but **none of the following exists in `src/` and none should be scaffolded without an explicit, separate request.** Building any of this speculatively would violate Progressive Complexity (Section 5) at the architecture level, not just the Module level.

* **`RuntimeEnv` reserved values:** `'vscode' | 'electron' | 'node'` exist in the type (`src/kernel/module.ts`) purely so a future Module can declare intent (`supportedEnvs: ['vscode']`) and have the Environment Guard reject it cleanly on today's browser-extension-only Kernel, rather than the value not existing at all.
* **Intended Port → Adapter mapping**, if/when a given host is targeted:

  | Port | Browser Extension Adapter (implemented) | VS Code Adapter (planned) | Electron Adapter (planned) |
  |---|---|---|---|
  | `IStoragePort` (→ `CacheService`) | `chrome.storage.local` / `chrome.storage.session` | `vscode.ExtensionContext.globalState` | Node local file / embedded db |
  | `IMessagingPort` (→ `BusService`) | `chrome.runtime.sendMessage` / `chrome.runtime.connect` | VS Code `EventEmitter` / Node `EventEmitter` | `ipcRenderer` / `ipcMain` |
  | Host Interactivity Port (→ the `dom` capability) | content-script DOM injection | `vscode.workspace` / `vscode.window` (editors, files, selections) | scripts inside a `BrowserWindow`/`WebView` |
  | `IAIAdapterPort` (→ `AiService`) | `fetch()` from the background service worker | Node HTTP client or local model runner | Node HTTP client or local model runner |

* **Why this is deferred, not abandoned:** the Core (`src/kernel/`) already has zero `chrome.*` imports — Modules only depend on the `Module`/`AiService`/`CacheService`/`BusService` contracts in `src/kernel/module.ts`, and Services are injected via `ServiceInjector` rather than imported directly. The project structure (§7) already reserves `src/adapters/<env>/` as a sibling location — `src/adapters/browser-extension/` is the only one populated today. That's the Hexagonal boundary that would let a second Adapter be added later without touching the Core. What's missing is simply the second Adapter itself, plus its own build target (a `build:<env>` script and bundler config, per §7), and neither should be built until there's an actual second target to run against.

---

### Strategic Summary

Synapse is now a **minimalist Hexagonal Core** (`Kernel` + `Module` contracts) surrounded by **on-demand Ports/Services**, currently backed entirely by **one Adapter: the browser extension.** You do not build a "heavy agentic machine" and force every task through it—you build a small core capable of "sprouting" the necessary infrastructure exactly where and when required, based on individual Module declarations. This keeps the playground lightweight enough for "vibe-coding" quick personal tasks, while remaining open-ended for complex AI experiments, without requiring a complete platform refactor — and, per Section 8, without requiring a Core rewrite if a second host runtime is ever targeted.