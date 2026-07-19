---
mode: agent
description: Scaffold the minimal Synapse Kernel (Manifest Resolver, Service Injector, Scheduler) for the MV3 browser extension target.
---

Scaffold the Synapse Kernel — the only mandatory part of the system (docs/design.md §3.A, §7). It
stays thin: resolve a Module's `needs[]`, inject just those Services, run the Module. Never add
AI/Decision-Engine logic to the Kernel itself — that belongs inside Modules.

Guard: if `src/kernel/` already exists, stop and ask before touching it.

Synapse is a Manifest V3 browser extension, structured as a Hexagonal Core/Adapter split
(docs/design.md §1, §7, §8) — `src/kernel/` is the platform-agnostic Core, and everything
browser-specific lives under `src/adapters/browser-extension/`, never directly under `src/`. This
means:
- The Kernel core (`src/kernel/`) stays platform-agnostic — no `chrome.*` calls in
  `module.ts`/`service-injector.ts`/`scheduler.ts`/`environment-guard.ts`. Only the Service
  *implementations* (factories passed into the Kernel) touch `chrome.*`.
- The Kernel instance lives in the background service worker, which MV3 can kill and restart
  between events at any time — never rely on in-memory state surviving; Cache/Session State must
  be backed by `chrome.storage`.
- Every Module optionally declares `supportedEnvs: RuntimeEnv[]` (`RuntimeEnv = 'browser-extension'
  | 'vscode' | 'electron' | 'node'`); omitting it defaults to `['browser-extension']`, the only
  value with a real Adapter. The other values are reserved placeholders only — never build
  `vscode`/`electron`/`node`-specific code.

Create:

`src/kernel/module.ts` — the `Module`/`Capability`/`RuntimeEnv`/`ModuleContext`/`AiService`/
`CacheService`/`BusService` contracts (`Capability = 'net' | 'ai' | 'cache' | 'bus' | 'dom'`).
`Module` includes an optional `supportedEnvs?: RuntimeEnv[]`.

`src/kernel/service-injector.ts` — a `ServiceInjector` class that lazily resolves only the
services a Module's `needs[]` actually lists, throwing if a factory for a needed capability wasn't
registered.

`src/kernel/environment-guard.ts` — `assertEnvSupported(mod, currentEnv)`: throws
`EnvironmentMismatchError` if `mod.supportedEnvs` (defaulting to `['browser-extension']`) doesn't
include `currentEnv`.

`src/kernel/scheduler.ts` — a `Scheduler` with `runPipeline(modules, input)` (sequential, for
Modules without `bus`) and `registerOnBus(mod, bus)` (for Modules declaring `bus`). If a Module
declares `dom`, routing goes through messaging to a content script, not a direct call.

`src/kernel/index.ts` — a `Kernel` class taking `(injector, currentEnv = 'browser-extension')`,
running `assertEnvSupported` over every Module before splitting them into pipeline vs
bus-registered on `run()`.

`src/adapters/browser-extension/background/index.ts` — where the Kernel actually runs: construct
it with `chrome.runtime` factories (only wire `ai`/`cache`/`bus` factories once a Module actually
needs them — empty `factories: {}` is correct for a `net`-only project), and listen via
`chrome.runtime.onMessage` (return `true` to keep the channel open for async `sendResponse`).

`src/adapters/browser-extension/content-scripts/relay.ts` — a `registerDomModule(mod)` helper:
content scripts don't run the Kernel, they just host `dom`-declaring Modules invoked *from*
background via message; the relay forwards the call and returns the result via `sendResponse`.

Don't build anything under a hypothetical `src/adapters/vscode/` or `src/adapters/electron/` —
those are documented as a roadmap in docs/design.md §8, not a task.

Reference Service implementations (only write when a Module actually needs the capability):
- `CacheService` backed by `chrome.storage.local.get`/`.set`.
- `BusService` backed by `chrome.runtime.sendMessage`/`chrome.runtime.onMessage` (or
  `chrome.runtime.connect` for long-lived/streaming needs).

After scaffolding: point the user at `/module-scaffold` for creating Modules against this
contract; report which files were created; don't run a build/typecheck unless the project already
has `tsconfig.json`/tooling configured.
