---
name: module-scaffold
description: Scaffold a new Synapse Module (TypeScript) following the Kernel + Capability Declaration pattern from docs/design.md — a manifest (needs[]/scopes[]) plus a run() function, sized to exactly what it declares, placed in the right browser-extension context (background vs content script). Use when the user asks to create/add/vibe-code a new module, task, or automation for Synapse.
---

# Module Scaffold

Create a new Synapse Module matching the architecture in `docs/design.md` (`## 2. Core Concepts`, `## 3.B Module Layer`, `## 7. Tech Stack & Execution Contexts`). The whole point of this
architecture is that a module's complexity is exactly proportional to what it declares — don't add
machinery it didn't ask for.

## Before writing anything

Ask (only what's missing from context):
1. **Purpose** — one sentence, what does this module do.
2. **Services needed (`needs`)** — pick from `ai`, `cache`, `bus`, or none. If the user describes
   a purely deterministic task (fetch/parse/transform/format), the answer is `none` — resist
   adding `ai`/`bus` unless the task genuinely needs AI judgment or cross-module coordination.
   `'net'` and `'dom'` are **not** capabilities any more (docs/ROADMAP.md §11.3): they resolved to
   no Service, so declaring them did nothing. `fetch` is just available; "must run as a content
   script" is decided by *where you put the file*, not by a field.
2b. **Scopes needed (`scopes`)** — usually none. This is the permission axis (`storage.rw`, …),
   separate from `needs`, and it's what the consent UI shows. See `userscript-api` before adding
   one; a bundled Module's declaration is auto-granted, so over-declaring here is invisible at run
   time and misleading in the popup.
3. **Input/output shape** — rough idea of what `run()` receives and returns.
4. **External dependency check** — if the module's purpose centers on a specific third-party
   library/SDK/API (not a platform primitive like `fetch`/`chrome.*`), run the checklist in the
   `doc-sync` skill's "Auto-invocation from other skills" section before writing the module body.
   That skill owns the criteria for when a local KB is actually warranted and how to confirm with
   the user before crawling — don't re-derive that logic here, just defer to it.

Never ask about a target runtime. There is no `supportedEnvs` field and no `RuntimeEnv` type — the
browser extension is the only runtime Synapse targets, by decision after an audit, not by "not yet"
(docs/design.md §8, docs/ROADMAP.md §11.1). If the user raises vscode/electron/node, say that
plainly rather than scaffolding as if a Module could declare its way there.

## Placement convention

- **Background, and genuinely portable:** `src/modules/<kebab-case-name>.module.ts` — runs in the
  background service worker. This location is Adapter-agnostic on purpose (docs/design.md §7
  Project Structure): it depends only on `kernel/module` Ports, not on `chrome.*` — not even
  transitively through an imported util — so it stays put even if a second Adapter is ever added.
  If the module's logic would need to change for a hypothetical second Adapter, it isn't portable —
  use the next option instead.
- **Background, but browser-specific** (e.g. it orchestrates `chrome.scripting`, or otherwise calls
  browser-extension-only infra even though it doesn't touch the page's DOM itself):
  `src/adapters/browser-extension/background/modules/<kebab-case-name>/index.ts` — a folder with an
  `index.ts` entry (plus any colocated support files the module needs, e.g. a MAIN-world
  composition root — see the `main-world-interceptor` skill for that specific case). Still runs in
  the background service worker; the folder-per-module shape exists because these modules tend to
  need more than one file. Auto-discovered the same way as bundled content-script Modules (see
  below), via a separate glob (`module-registry/background-modules.ts`) scoped to this folder.
- **Needs the page's DOM:** `src/adapters/browser-extension/content-scripts/modules/<kebab-case-name>.module.ts`
  — runs in the page context, which is specific to the browser-extension Adapter. Its `ctx.services`
  is empty (Kernel Services are background-only); what it gets instead is `ctx.api`, the same
  `synapseApi` an uploaded user script sees, relayed to background over RPC. Anything beyond that
  surface is its own `chrome.runtime.sendMessage` round trip.

Create the relevant folder if it doesn't exist yet. If `src/kernel/` doesn't exist yet (Kernel not
bootstrapped — see `kernel-bootstrap` skill), still scaffold the module against the
`Module` shape below as a local type stub; don't block module creation on the Kernel
existing.

**If `src/adapters/browser-extension/module-registry/bundled-modules.ts` exists** (the
`module-registry` skill has been applied), placing a `.module.ts` file in
`content-scripts/modules/` is *all* that's needed — it's auto-discovered via
`import.meta.glob` and auto-registered in `content-scripts/index.ts`. Do **not** manually add an
import/`registerDomModule(...)` call anywhere; that file no longer hand-registers Modules and
adding a duplicate registration would double-dispatch. The new Module also appears in the popup
automatically, with its declared `scopes` auto-granted (bundled Modules are trusted build-time
code — the grant is derived from the declaration on read, never persisted). Only fall back to the manual `registerDomModule(YourModule)` pattern described below if
`bundled-modules.ts` doesn't exist yet.

## Template — simple module (no `needs`, no `scopes`)

```ts
import type { Module } from '../kernel/module';

export const <Name>Module: Module<InputT, OutputT> = {
  id: '<kebab-case-name>',
  async run(input) {
    // plain, deterministic logic — no ctx.services needed
    return output;
  },
};
```

## Template — module with capabilities (ai / cache / bus)

```ts
import type { Module } from '../kernel/module';

export const <Name>Module: Module<InputT, OutputT> = {
  id: '<kebab-case-name>',
  needs: ['ai', 'cache'],
  async run(input, ctx) {
    const cached = await ctx.services.cache.get(input.key);
    if (cached) return cached;

    const result = isSimpleCase(input)
      ? ruleBasedLogic(input)
      : await ctx.services.ai.ask(input); // routed through the Throttled AI Adapter

    await ctx.services.cache.set(input.key, result);
    return result;
  },
};
```

Only destructure `ctx.services.X` for an `X` actually listed in `needs` — the Kernel only injects
what's declared, so reaching for an undeclared service is a bug, not a convenience.

## Template — content-script module

Nothing declares this — a Module is a content-script Module because its file lives under
`content-scripts/modules/`, which is what `bundled-modules.ts` globs. (There used to be a
`needs: ['dom']` marker; it injected no Service and is gone.)

```ts
import type { Module } from '../../../../kernel/module';

export const <Name>Module: Module<InputT, OutputT> = {
  id: '<kebab-case-name>',
  async run(input) {
    // direct document/window access — this only runs as a content script
    const value = document.querySelector(input.selector)?.textContent;
    return { value };
  },
};
```

If `content-scripts/modules/bundled-modules.ts` (glob auto-discovery) doesn't exist yet, register
it manually with the content-script relay from `kernel-bootstrap` (`registerDomModule(...)`), not
by calling it directly — the background Kernel invokes it via messaging, it never runs in-process
with other Modules. If auto-discovery *does* exist (the `module-registry` skill has been applied),
skip this — see the note above.

## Rules

- **Don't add a Decision Engine branch** (`isSimpleCase` / AI fallback) unless the task is
  genuinely ambiguous. A deterministic task doesn't need one just because the template shows it.
- **Don't declare `bus`** unless this module truly needs to run decoupled/async from others via
  the Event Bus. Most one-off personal-automation modules run fine as a direct pipeline step.
- **Don't add `supportedEnvs`** — the field, the `RuntimeEnv` type, and the Environment Guard were
  all removed (docs/design.md §8). A Module declares capabilities and execution context, nothing
  about a host runtime.
- **Don't conflate `needs` with `scopes`.** `needs` = which Kernel Services get injected into
  `ctx.services` (build-time DI). `scopes` = what the user is asked to permit. A Module needing
  neither declares neither.
- Keep `run()` `async` even if the body is fully sync, for uniform Kernel scheduling.
- After scaffolding, report which `needs`/`scopes` were declared and why, so the user can catch an
  over-declared module early. For a content-script module under auto-discovery, also mention that
  no manual wiring is needed and that it'll show up in the popup once the extension reloads.
