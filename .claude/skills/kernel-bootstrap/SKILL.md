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
1. The Kernel itself (`src/kernel/`) stays platform-agnostic — no `chrome.*` calls in
   `module.ts`/`service-injector.ts`/`scheduler.ts`/`environment-guard.ts`. Only the *Service
   implementations* (the factories passed into the Kernel) touch `chrome.*`.
2. The Kernel instance lives in the **background service worker**, which MV3 can kill and restart
   between events at any time. Never rely on in-memory state surviving between invocations —
   `Cache`/`Session State` implementations must read/write `chrome.storage`, not a plain `Map`.

This platform-agnostic Core is what docs/design.md §1 calls **Hexagonal Architecture**: the Kernel
+ `Module` contract is the Core, `AiService`/`CacheService`/`BusService` are the Ports, and the
`chrome.*`-backed factories below are the (only) Adapter. `RuntimeEnv` (in `module.ts`) has
reserved values (`'vscode' | 'electron' | 'node'`) for future Adapters — **do not implement
anything for them**, they exist only so the Environment Guard can reject a mismatched Module
cleanly. See docs/design.md §8 for the (unbuilt) roadmap.

## Guard

Check for `src/kernel/` first. If it already exists, stop and ask the user before touching it —
this skill is for the initial bootstrap, not for re-scaffolding over an existing Kernel.

## Files to create

### `src/kernel/module.ts` — the contract every Module implements

```ts
export type Capability = 'net' | 'ai' | 'cache' | 'bus' | 'dom';

// Only 'browser-extension' has an Adapter. The rest are reserved — never build for them here.
export type RuntimeEnv = 'browser-extension' | 'vscode' | 'electron' | 'node';

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
  // Defaults to ['browser-extension'] when omitted — see environment-guard.ts.
  supportedEnvs?: RuntimeEnv[];
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

### `src/kernel/environment-guard.ts` — the Environment Guard

```ts
import type { Module, RuntimeEnv } from './module';

export class EnvironmentMismatchError extends Error {
  constructor(public moduleId: string, public currentEnv: RuntimeEnv, public supportedEnvs: RuntimeEnv[]) {
    super(`Module "${moduleId}" does not support runtime "${currentEnv}" (supports: ${supportedEnvs.join(', ')})`);
  }
}

export function assertEnvSupported(mod: Module, currentEnv: RuntimeEnv): void {
  const supported = mod.supportedEnvs ?? ['browser-extension'];
  if (!supported.includes(currentEnv)) {
    throw new EnvironmentMismatchError(mod.id, currentEnv, supported);
  }
}
```

### `src/kernel/scheduler.ts` — sync pipeline vs bus dispatch

```ts
import type { Module } from './module';
import type { ServiceInjector } from './service-injector';

export class Scheduler {
  constructor(private injector: ServiceInjector) {}

  /** Direct pipeline: modules without 'bus' run in sequence, output feeds the next input. */
  async runPipeline(modules: Module[], initialInput: unknown): Promise<unknown> {
    let value = initialInput;
    for (const mod of modules) {
      const ctx = this.injector.resolve(mod.needs);
      value = await mod.run(value, ctx);
    }
    return value;
  }

  /** Bus dispatch: modules declaring 'bus' get registered instead of called directly. */
  registerOnBus(mod: Module, bus: { on: Function }): void {
    const ctx = this.injector.resolve(mod.needs);
    bus.on(mod.id, (payload: unknown) => mod.run(payload, ctx));
  }
}
```

### `src/kernel/index.ts` — the Kernel entry point

```ts
import { ServiceInjector } from './service-injector';
import { Scheduler } from './scheduler';
import { assertEnvSupported } from './environment-guard';
import type { Module, RuntimeEnv } from './module';

export class Kernel {
  private scheduler: Scheduler;

  constructor(private injector: ServiceInjector, private currentEnv: RuntimeEnv = 'browser-extension') {
    this.scheduler = new Scheduler(injector);
  }

  async run(modules: Module[], input: unknown): Promise<unknown> {
    for (const mod of modules) assertEnvSupported(mod, this.currentEnv);

    const [pipelineModules, busModules] = partition(modules, (m) => !m.needs?.includes('bus'));
    for (const mod of busModules) {
      const ctx = this.injector.resolve(mod.needs);
      if (ctx.services.bus) this.scheduler.registerOnBus(mod, ctx.services.bus);
    }
    return this.scheduler.runPipeline(pipelineModules, input);
  }
}

function partition<T>(arr: T[], pred: (x: T) => boolean): [T[], T[]] {
  const yes: T[] = [], no: T[] = [];
  for (const x of arr) (pred(x) ? yes : no).push(x);
  return [yes, no];
}
```

The Environment Guard runs first, over *all* modules passed to `run()`, before any pipeline/bus
split — a Module targeting the wrong runtime should never reach the Service Injector.

## Placement: background entry point + content-script relay

The Kernel itself is platform-agnostic (`src/kernel/`), but it only ever *runs* inside a specific
Adapter's background service worker. All browser-extension-specific code — including this
entry point and the content-script relay — lives under `src/adapters/browser-extension/`, never
directly under `src/`, so a future Adapter has an unambiguous sibling location (docs/design.md §7,
§8).

### `src/adapters/browser-extension/background/index.ts` — where the Kernel actually lives

```ts
import { Kernel } from '../../../kernel';
import { ServiceInjector } from '../../../kernel/service-injector';
// import concrete factories once the user actually needs ai/cache/bus — see below

const kernel = new Kernel(new ServiceInjector({
  // ai: () => chromeAiAdapter,
  // cache: () => chromeStorageCache,
  // bus: () => chromeRuntimeBus,
}));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  kernel.run(/* resolve modules for message.workflowId */ [], message.input)
    .then(sendResponse);
  return true; // keep the message channel open for the async sendResponse
});
```

### `src/adapters/browser-extension/content-scripts/relay.ts` — thin relay for `dom`-declaring Modules

Content scripts don't run the Kernel — they only host Modules that need `document`/`window`. A
content-script Module still gets invoked *from* the background via the Bus; the relay just
forwards background → content-script calls and returns results:

```ts
import type { Module } from '../../../kernel/module';

export function registerDomModule(mod: Module) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.moduleId !== mod.id) return; // not for us
    mod.run(message.input, { services: {} }).then(sendResponse);
    return true;
  });
}
```

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
`factories: {}` is the correct state for a project with only `net`-only Modules so far.

## After scaffolding

- Don't wire real `ai`/`cache`/`bus` factory implementations yet unless the user asks — leave
  `Kernel` construction with factories the user supplies, so a Module-only project never needs to
  configure services it doesn't use.
- Point the user at the `module-scaffold` skill for creating Modules against this `Module` type.
- Don't build a `vscode`/`electron`/`node` Adapter, factory, or entry point even if the user
  mentions one in passing — those `RuntimeEnv` values are reserved placeholders only (docs/design.md
  §8). Confirm explicitly before starting any work on a second Adapter.
- Report which files were created; don't run a build/typecheck unless the project already has
  `tsconfig.json`/tooling configured (check first — this may be the first TS code in the repo).
