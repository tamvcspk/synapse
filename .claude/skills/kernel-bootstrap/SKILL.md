---
name: kernel-bootstrap
description: Scaffold the minimal Synapse Kernel (Manifest Resolver, Service Injector, Execution Scheduler) in TypeScript for the Manifest V3 browser extension target, matching docs/design.md sections 3.A and 7. Use once, when the project has no src/kernel yet and the user wants to start writing the actual runtime instead of just modules.
---

# Kernel Bootstrap

Scaffold the Kernel core described in `docs/design.md` — the *only* mandatory part of Synapse. It
stays deliberately thin: it resolves a Module's `needs[]`, injects just those Services, and runs
the Module. It must never grow AI/Decision-Engine logic itself — that belongs inside Modules.

Synapse is a **Manifest V3 browser extension** (docs/design.md §7). This shapes the Kernel in two
ways:
1. The Kernel itself (`src/kernel/`) stays free of `chrome.*` — no such calls in
   `module.ts`/`service-injector.ts`/`scheduler.ts`. Only the *Service implementations* (the
   factories passed into the Kernel) touch `chrome.*`.
2. The Kernel instance lives in the **background service worker**, which MV3 can kill and restart
   between events at any time. Never rely on in-memory state surviving between invocations —
   `Cache`/`Session State` implementations must read/write `chrome.storage`, not a plain `Map`.

This `chrome.*`-free Core is what docs/design.md §1 calls **Hexagonal Architecture**: the Kernel +
`Module` contract is the Core, `AiService`/`CacheService`/`BusService` are the Ports, and the
`chrome.*`-backed factories below are the (only) Adapter.

**A second Adapter is ruled out — this shipped (docs/ROADMAP.md §11.1, docs/design.md §8).** An
audit found ~0% of the browser-extension Adapter could ever port: every feature depends on
`chrome.webRequest`, DNR, CDP, `chrome.userScripts`, Offscreen Documents, or a real web page.
Synapse's domain *is* the browser. Hexagonal is retained for **testability and dependency
discipline** — keeping `kernel/` and `shared/` provably free of `chrome.*`, which is what lets
`npm test` run them in plain Node — **not** for portability; never justify a design choice by
appealing to a future Adapter.

Consequently there is **no `RuntimeEnv` type, no `Module.supportedEnvs`, and no
`kernel/environment-guard.ts`.** Don't scaffold any of them, and don't add a `currentEnv` parameter
to the Kernel constructor. A Module declares *capabilities* and *execution context*, never a host
runtime.

## Guard

Check for `src/kernel/` first. If it already exists, stop and ask the user before touching it —
this skill is for the initial bootstrap, not for re-scaffolding over an existing Kernel.

**In this repo the Kernel exists and has since diverged from the templates below** — they are kept
as the minimal shape, not as a description of the current code. Two differences that matter if you
read them for reference: `Capability` is `'ai' | 'cache' | 'bus'` (`'net'`/`'dom'` were removed —
they injected no Service, so declaring them was a silent no-op), and `ModuleContext` also carries
`api: SynapseApi`, the public contract (`kernel/synapse-api.ts`, see `userscript-api`), which is
built per-Module by an `api` factory on the injector. Permission lives on `Module.scopes`, not on
`needs`.

## Files to create

### `src/kernel/module.ts` — the contract every Module implements

```ts
export type Capability = 'ai' | 'cache' | 'bus';

export interface ModuleContext {
  services: Partial<{
    ai: AiService;
    cache: CacheService;
    bus: BusService;
  }>;
}

export interface Module<In = unknown, Out = unknown> {
  id: string;
  needs?: Capability[];
  run(input: In, ctx: ModuleContext): Promise<Out>;
}

export interface AiService {
  ask(input: unknown): Promise<unknown>;
}

export interface CacheService {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export interface BusService {
  emit(event: string, payload: unknown): void;
  on(event: string, handler: (payload: unknown) => void): void;
}

// Reported by the Scheduler when a Module's run() throws, instead of crashing the pipeline/bus.
export interface ModuleFailure {
  moduleId: string;
  error: string;
}
```

### `src/kernel/service-injector.ts` — lazy, opt-in service instantiation

```ts
import type { AiService, BusService, Capability, CacheService, ModuleContext } from './module';

export class ServiceInjector {
  private ai?: AiService;
  private cache?: CacheService;
  private bus?: BusService;

  constructor(private factories: {
    ai?: () => AiService;
    cache?: () => CacheService;
    bus?: () => BusService;
  }) {}

  resolve(needs: Capability[] = []): ModuleContext {
    const services: ModuleContext['services'] = {};

    if (needs.includes('ai')) {
      services.ai = this.ai ??= this.requireFactory('ai', this.factories.ai)();
    }
    if (needs.includes('cache')) {
      services.cache = this.cache ??= this.requireFactory('cache', this.factories.cache)();
    }
    if (needs.includes('bus')) {
      services.bus = this.bus ??= this.requireFactory('bus', this.factories.bus)();
    }

    return { services };
  }

  private requireFactory<T>(name: string, factory?: () => T): () => T {
    if (!factory) throw new Error(`No factory registered for capability "${name}"`);
    return factory;
  }
}
```

Only the capabilities a Module declares get touched — a Module with `needs: []` never triggers
any factory call.

### `src/kernel/scheduler.ts` — sync pipeline vs bus dispatch

```ts
import type { Module, ModuleFailure } from './module';
import type { ServiceInjector } from './service-injector';

function toFailure(mod: Module, err: unknown): ModuleFailure {
  return { moduleId: mod.id, error: err instanceof Error ? err.message : String(err) };
}

export class Scheduler {
  constructor(private injector: ServiceInjector) {}

  /**
   * Direct pipeline: modules without 'bus' run in sequence, output feeds the next input.
   * A throwing module is reported via onFailure and treated as a pass-through no-op (the
   * previous value flows to the next module) rather than aborting the pipeline — this must
   * hold uniformly regardless of Module source (bundled or uploaded, see the module-registry
   * skill), since there's no compile-time guarantee for uploaded code.
   */
  async runPipeline(modules: Module[], initialInput: unknown, onFailure?: (f: ModuleFailure) => void): Promise<unknown> {
    let value = initialInput;
    for (const mod of modules) {
      const ctx = this.injector.resolve(mod.needs);
      try {
        value = await mod.run(value, ctx);
      } catch (err) {
        onFailure?.(toFailure(mod, err));
      }
    }
    return value;
  }

  /** Bus dispatch: modules declaring 'bus' get registered instead of called directly. */
  registerOnBus(mod: Module, bus: { on: Function }, onFailure?: (f: ModuleFailure) => void): void {
    const ctx = this.injector.resolve(mod.needs);
    bus.on(mod.id, async (payload: unknown) => {
      try {
        await mod.run(payload, ctx);
      } catch (err) {
        onFailure?.(toFailure(mod, err));
      }
    });
  }
}
```

### `src/kernel/index.ts` — the Kernel entry point

```ts
import { ServiceInjector } from './service-injector';
import { Scheduler } from './scheduler';
import type { Module, ModuleFailure } from './module';

export class Kernel {
  private scheduler: Scheduler;

  constructor(private injector: ServiceInjector) {
    this.scheduler = new Scheduler(injector);
  }

  async run(modules: Module[], input: unknown, onFailure?: (f: ModuleFailure) => void): Promise<unknown> {
    const [pipelineModules, busModules] = partition(modules, (m) => !m.needs?.includes('bus'));
    for (const mod of busModules) {
      const ctx = this.injector.resolve(mod.needs);
      if (ctx.services.bus) this.scheduler.registerOnBus(mod, ctx.services.bus, onFailure);
    }
    return this.scheduler.runPipeline(pipelineModules, input, onFailure);
  }
}

function partition<T>(arr: T[], pred: (x: T) => boolean): [T[], T[]] {
  const yes: T[] = [], no: T[] = [];
  for (const x of arr) (pred(x) ? yes : no).push(x);
  return [yes, no];
}
```

`onFailure` is optional and purely additive — omitting it preserves the original
(pre-graceful-fail) contract for any caller that doesn't care about per-Module failure reporting.

## Placement: background entry point + content-script relay

The Kernel itself is platform-agnostic (`src/kernel/`), but it only ever *runs* inside a specific
Adapter's background service worker. All browser-extension-specific code — including this
entry point and the content-script relay — lives under `src/adapters/browser-extension/`, never
directly under `src/`. Not to reserve room for a sibling Adapter (there won't be one, design.md §8)
but because that nesting is what makes "does `kernel/` import `chrome.*`?" a question with a
mechanical answer.

### `src/adapters/browser-extension/background/index.ts` — where the Kernel actually lives

```ts
import { Kernel } from '../../../kernel';
import { ServiceInjector } from '../../../kernel/service-injector';
// import concrete factories once the user actually needs ai/cache/bus — see below

const injector = new ServiceInjector({
  // ai: () => chromeAiAdapter,
  // cache: () => chromeStorageCache,
  // bus: () => chromeRuntimeBus,
});
const kernel = new Kernel(injector);

// Run whatever Modules this project actually has, e.g. the background-module set:
void kernel.run(BACKGROUND_MODULES, undefined, (failure) => {
  console.error(`Synapse: background module "${failure.moduleId}" failed`, failure.error);
});
```

**Don't scaffold a generic `message.workflowId` → `kernel.run(...)` dispatch listener.** An earlier
version of this skill did, and the result sat in `background/index.ts` for months as
`kernel.run([], message.input)` — a hardcoded empty array, with `workflowId` read by nothing — until
§11.1 deleted it. Worse, a listener that calls `sendResponse` unconditionally *wins the race*
against every other listener for the same message (Chrome takes whichever `sendResponse` lands
first), which turned into a real bug once request/response relays were added. Wire a dispatch only
when there is a concrete caller and a concrete Workflow to dispatch to, and always guard it on a
required field of its own message shape before touching `sendResponse`.

If the user also wants Module activate/deactivate, uploaded modules, or a popup UI, that's the
separate **`module-registry`** skill — it layers `registerRpcHandler(injector)` and
`chrome.userScripts.configureWorld(...)` onto this same `background/index.ts`. Don't add those
calls here unless asked; this skill only bootstraps the baseline Kernel.

### `src/adapters/browser-extension/content-scripts/relay.ts` — thin relay for `dom`-declaring Modules

Content scripts don't run the Kernel — they only host Modules that need `document`/`window`. A
content-script Module still gets invoked *from* the background via messaging; the relay forwards
the call and returns the result. Wrap the call in try/catch (a throwing Module must not leave the
message channel hanging — same graceful-fail principle as the Scheduler above):

```ts
import type { Module } from '../../../kernel/module';

export function registerDomModule(mod: Module) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.moduleId !== mod.id) return; // not for us
    (async () => {
      try {
        sendResponse(await mod.run(message.input, { services: {} }));
      } catch (err) {
        sendResponse({ error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  });
}
```

If the `module-registry` skill has already been applied, `registerDomModule` also gates on the
persisted active flag (`module-registry/storage.ts`'s `isModuleActive`) before dispatching — check
whether that file exists before assuming this bare version is current.

A `dom` Module typically doesn't need `ai`/`cache`/`bus` *itself* — if it does, route through the
background via `chrome.runtime.sendMessage` from inside `run()`, don't reimplement those services
in the content-script context.

## Reference Service implementations (background-only, wire in when actually needed)

```ts
// src/adapters/browser-extension/background/services/cache.ts
import type { CacheService } from '../../../../kernel/module';

export const chromeStorageCache: CacheService = {
  async get(key) {
    const result = await chrome.storage.local.get(key);
    return result[key];
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
};
```

```ts
// src/adapters/browser-extension/background/services/bus.ts
import type { BusService } from '../../../../kernel/module';

export const chromeRuntimeBus: BusService = {
  emit(event, payload) {
    chrome.runtime.sendMessage({ event, payload });
  },
  on(event, handler) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.event === event) handler(message.payload);
    });
  },
};
```

Don't write these until a Module actually declares the corresponding capability — an empty
`factories: {}` is the correct state for a project with only `net`-only Modules so far. When a
factory does end up wrapping a specific third-party SDK (e.g. a particular AI provider's client),
check the `doc-sync` skill's "Auto-invocation from other skills" checklist first — the same
version-drift risk applies here as in any Module.

## After scaffolding

- Don't wire real `ai`/`cache`/`bus` factory implementations yet unless the user asks — leave
  `Kernel` construction with factories the user supplies, so a Module-only project never needs to
  configure services it doesn't use.
- Point the user at the `module-scaffold` skill for creating Modules against this `Module` type,
  and at the `module-registry` skill if they want auto-discovery, activate/deactivate, or
  runtime-uploaded Modules (a separate, optional layer on top of this baseline Kernel).
- Don't build a `vscode`/`electron`/`node` Adapter, factory, entry point, or runtime-env type even
  if the user mentions one in passing — that direction was audited and rejected (docs/design.md §8),
  not merely deferred. Say so and confirm explicitly before starting any work on a second Adapter.
- Report which files were created; don't run a build/typecheck unless the project already has
  `tsconfig.json`/tooling configured (check first — this may be the first TS code in the repo).
