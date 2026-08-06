---
name: kernel-bootstrap
description: The Synapse Kernel's invariants — what the Core (Manifest Resolver, Service Injector, Execution Scheduler) is allowed to be, and the rules that must hold when changing src/kernel/ or the background composition root. Use when editing the Kernel, the Service factories, or background/index.ts, or when asked why the Kernel is shaped the way it is.
---

# Kernel invariants

The Kernel is the only mandatory part of Synapse and is deliberately thin: it reads a Module's
declarations, injects exactly the Services declared, and runs it. **It must never grow AI or
decision-engine logic** — that belongs inside Modules.

> **This is not a scaffolding skill.** The Kernel exists (`src/kernel/`) and has diverged from any
> template. Read the real files; this skill records the rules that made them that shape. If you find
> yourself creating `src/kernel/`, stop — you are in the wrong repo.

## The five invariants

1. **`src/kernel/` imports no `chrome.*`, no DOM, no I/O.** Only Service *implementations* — the
   factories passed in from `background/index.ts` — touch `chrome.*`. The reason is **testability
   and MAIN-world survivability**, both checkable on every commit; it is **not** portability. Never
   justify a Kernel design choice by appealing to a hypothetical second host (see §4).

2. **The Kernel runs in the background service worker, which Chrome kills at will.** Never hold
   critical state in memory across events. Anything that must survive goes through `chrome.storage`.
   An in-memory flag tracking external state (e.g. "is this script registered?") *will* drift —
   query the real source instead.

3. **`needs` and `scopes` are different axes and must stay separate fields.**
   `needs: 'ai' | 'cache' | 'bus'` is build-time DI deciding what lands in `ctx.services`.
   `scopes` is permission, shown to the user, enforced in `rpc-handler.ts`.
   `'net'` and `'dom'` are **not** capabilities — they resolved to no Service, so declaring them was
   a silent no-op, and they were removed. `bus` can be a Capability but must never become a Scope.

4. **A throwing `run()` is caught and reported, never allowed to abort the pipeline or bus
   dispatch.** This holds uniformly regardless of Module source — uploaded code has no compile-time
   guarantee of correctness, and one bad Module must not take down the others. Callers should not
   add a second layer of error handling around `kernel.run()` that duplicates this.

5. **Discovery order is not execution order.** A glob's iteration order is meaningless for
   sequencing. If Modules must run in a specific order, that is a `Workflow` (`{id, steps: string[]}`,
   `kernel/workflow.ts`) resolved explicitly — never inferred from a registry listing.

## Bus registration has a trap worth knowing

`Kernel.run` splits Modules by exactly one condition: whether `needs` includes `'bus'`. A Module
that listens on the Bus but forgets to declare it is never registered, so its messages fall into
nothing — **and the write path may report success anyway** if the caller only treats an explicit
`{ok:false}` as failure (a missing listener means no response at all, which is not `ok:false`).
This shipped once and presented as "saving silently does nothing". Check the declaration first when
a Bus-driven Module appears inert.

## No dispatch listener without a concrete caller

Do not add a generic `message.workflowId → kernel.run(...)` listener. One existed for months as
`kernel.run([], message.input)` — a hardcoded empty array, `workflowId` read by nothing — before it
was deleted. Worse, a listener that calls `sendResponse` unconditionally **wins the race** against
every other listener for the same message (Chrome takes whichever lands first), which became a real
bug once request/response relays existed. Wire a dispatch only when a concrete caller and a concrete
Workflow exist, and always guard on a required field of its own message shape before touching
`sendResponse`.

## Service factories: write them when a Module declares the capability, not before

`ServiceInjector` instantiates lazily and only what is declared; a Module declaring nothing triggers
no factory at all. That property is the point of "Progressive Complexity" — preserve it. The
concrete `chrome.*`-backed implementations live in `background/services/`.

`background/index.ts` is the **composition root**: it constructs the Kernel, supplies factories,
registers the RPC handler, and calls `chrome.userScripts.configureWorld(...)`. It owns wiring, never
business logic.

## The `chrome.userScripts.configureWorld` trap

That call needs a **synchronous** `try/catch` around the property access *and* the call, not just a
`.catch()` on the promise. When the user has not enabled "Allow user scripts", `chrome.userScripts`
is `undefined` — so the throw happens on property access, before any `.catch()` can attach. An
uncaught throw during service-worker top-level evaluation **discards every listener in the file**,
including the Bus registration every Module depends on. This shipped and broke all messaging, not
just uploaded-script support.

## Never

- **Never build a second Adapter** (`vscode`/`electron`/`node`), a runtime-env type, a
  `supportedEnvs` field, or an Environment Guard. Audited and rejected — `docs/design.md` §8. If the
  user raises it, say so plainly and confirm before doing any such work.
- **Never let a Module import Kernel internals.** Modules import from `kernel/module` only, never
  `service-injector`/`scheduler`.
- **Never put a feature's domain types in `kernel/module.ts`.** That file is the generic contract
  surface; a single feature's data shape belongs in `src/shared/` or beside its feature.

## See also

- `docs/INDEX.md` — where everything lives · `docs/GLOSSARY.md` — what the nouns mean
- `module-registry` skill — the upload/permission layer built on top of this Kernel
- `module-scaffold` skill — creating a Module against these contracts
