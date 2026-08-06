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
4. **Feature folder** — which `features/<name>/` does this belong to (see Placement below)? If none
   fits, the answer may be a new feature — check that its name would also work as a scope name.

If the module leans on an unfamiliar third-party library and you want its docs pinned locally,
the `doc-sync` skill can build one — it's available, not a required step. History says the gotchas
that actually bite here are MV3 runtime behaviours, not API surface, and those live in
`docs/LESSONS.md`; read that first.

Never ask about a target runtime. There is no `supportedEnvs` field and no `RuntimeEnv` type — the
browser extension is the only runtime Synapse targets, by decision after an audit, not by "not yet"
(docs/design.md §8, docs/ROADMAP.md §11.1). If the user raises vscode/electron/node, say that
plainly rather than scaffolding as if a Module could declare its way there.

## Placement convention — the `features/` axis

**Everything lives under `src/adapters/browser-extension/features/<feature>/`.** There is no
`src/modules/` and no `content-scripts/modules/` — both were removed when the feature axis landed
(docs/CHANGELOG.md §11.5). Read `docs/INDEX.md` for the current feature list before picking a home.

**Step 1 — pick the feature folder.** A new Module either joins an existing feature or starts a new
one. Feature names map **1:1 onto permission scope names** (`features/media/` ↔ `media.*`) — that
alignment is the reason the axis exists, so don't invent a feature name that couldn't also be a
scope name.

**Step 2 — pick the filename suffix, which is what actually decides discovery and execution
context.** MV3 partitions code by context and each has different `chrome.*` availability, so the
suffix is load-bearing, not decoration:

| Suffix | Runs in | Auto-discovered as a Module? |
|---|---|---|
| `*.background.ts` | service worker | ✅ via `module-registry/background-modules.ts` |
| `*.module.ts` | content script (ISOLATED) | ✅ via `module-registry/bundled-modules.ts` |
| `*.content.ts` | content script (ISOLATED) | ❌ — support file, wired by hand |
| `*.page.ts` | MAIN world of the real page | ❌ — no `chrome.*` at all |
| `*.offscreen.ts` | Offscreen Document | ❌ — **only `chrome.runtime`** |
| no suffix | more than one context | ❌ — a suffix here would lie |

The two globs are **deliberately different** and must not be unified: the background one matches
broadly (one service-worker bundle absorbs non-Module helpers harmlessly — they're filtered by
`typeof record?.run === 'function'`), the content one matches only `*.module.ts` so that
`all_frames`-scoped `*.content.ts` files don't get pulled into the wrong Vite entry. The authoritative
patterns live in those two files — read them, don't trust a copy in prose.

**Consequences of the suffix you pick:**

- `*.background.ts` — full `chrome.*`. This is where a Module orchestrating `chrome.scripting`/
  `declarativeNetRequest`/`chrome.debugger` belongs, even if it never touches page DOM.
- `*.module.ts` — page DOM available; `ctx.services` is **empty** (Kernel Services are
  background-only). What it gets instead is `ctx.api` (`synapseApi`), relayed to background over
  RPC — the same surface an uploaded user script sees. Anything beyond that surface is its own
  `chrome.runtime.sendMessage` round trip.

**Dropping a correctly-suffixed file in a feature folder is all the wiring there is.** It's
auto-discovered, auto-registered, and appears in the popup with its declared `scopes` auto-granted
(bundled Modules are trusted build-time code — the grant is derived from the declaration on read,
never persisted). Do **not** add a manual import or `registerDomModule(...)` call; the composition
roots (`background/index.ts`, `content-scripts/index.ts`) no longer hand-register Modules, and a
duplicate registration double-dispatches.

## Template — simple module (no `needs`, no `scopes`)

```ts
import type { Module } from '../../../../kernel/module';

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
import type { Module } from '../../../../kernel/module';

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

Nothing declares this — a Module is a content-script Module because its filename ends in
`.module.ts` inside a `features/<feature>/` folder, which is what `bundled-modules.ts` globs.
(There used to be a `needs: ['dom']` marker; it injected no Service and is gone.)

```ts
// src/adapters/browser-extension/features/<feature>/<name>.module.ts
import type { Module } from '../../../../kernel/module';

export const <Name>Module: Module<InputT, OutputT> = {
  id: '<kebab-case-name>',
  async run(input, ctx) {
    // direct document/window access — this only runs as a content script
    const value = document.querySelector(input.selector)?.textContent;
    // ctx.services is EMPTY here; ctx.api is the surface you get
    await ctx.api.storage.set('last', value);
    return { value };
  },
};
```

Live reference: `features/reader-mode/reader-mode-converter.module.ts` — the only `.module.ts` in
the repo today, and a Composite Module, so read it for the composed shape rather than as a minimal
example.

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
