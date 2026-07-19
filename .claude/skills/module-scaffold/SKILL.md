---
name: module-scaffold
description: Scaffold a new Synapse Module (TypeScript) following the Kernel + Capability Declaration pattern from docs/design.md — a manifest (needs[]) plus a run() function, sized to exactly the capabilities declared, placed in the right browser-extension context (background vs content script). Use when the user asks to create/add/vibe-code a new module, task, or automation for Synapse.
---

# Module Scaffold

Create a new Synapse Module matching the architecture in `docs/design.md` (`## 2. Core Concepts`, `## 3.B Module Layer`, `## 7. Tech Stack & Execution Contexts`). The whole point of this
architecture is that a module's complexity is exactly proportional to what it declares in
`needs[]` — don't add machinery it didn't ask for.

## Before writing anything

Ask (only what's missing from context):
1. **Purpose** — one sentence, what does this module do.
2. **Capabilities needed** — pick from `net`, `ai`, `cache`, `bus`, `dom`, or none. If the user
   describes a purely deterministic task (fetch/parse/transform/format), the answer is `none` or
   `['net']` — resist adding `ai`/`bus` unless the task genuinely needs AI judgment or
   cross-module coordination.
   - `dom` is special: it means "this Module must run as a content script" (background has no
     DOM). Confirm this is really needed — a Module that only *reads* page content already
     fetched via `net` doesn't need `dom`.
3. **Input/output shape** — rough idea of what `run()` receives and returns.
4. **External dependency check** — if the module's purpose centers on a specific third-party
   library/SDK/API (not a platform primitive like `fetch`/`chrome.*`), run the checklist in the
   `doc-sync` skill's "Auto-invocation from other skills" section before writing the module body.
   That skill owns the criteria for when a local KB is actually warranted and how to confirm with
   the user before crawling — don't re-derive that logic here, just defer to it.

Don't ask about `supportedEnvs` / target runtime unless the user brings it up themselves — Synapse
only ships the browser-extension Adapter today (docs/design.md §1, §8), so every Module implicitly
targets `['browser-extension']` by omitting the field. If the user does mention another runtime
(vscode/electron/node), tell them that `RuntimeEnv` value is a reserved placeholder with no Adapter
built yet (docs/design.md §8) and the Module can't actually run there — don't scaffold as if it
would.

## Placement convention

- **No `dom`, and genuinely portable:** `src/modules/<kebab-case-name>.module.ts` — runs in the
  background service worker. This location is Adapter-agnostic on purpose (docs/design.md §7
  Project Structure): it depends only on `kernel/module` Ports, not on `chrome.*` — not even
  transitively through an imported util — so it stays put even if a second Adapter is ever added.
  If the module's logic would need to change for a hypothetical second Adapter, it isn't portable —
  use the next option instead, even though this one also has no `dom`.
- **No `dom`, but browser-specific** (e.g. it orchestrates `chrome.scripting`, or otherwise calls
  browser-extension-only infra even though it doesn't touch the page's DOM itself):
  `src/adapters/browser-extension/background/modules/<kebab-case-name>/index.ts` — a folder with an
  `index.ts` entry (plus any colocated support files the module needs, e.g. a MAIN-world
  composition root — see the `main-world-interceptor` skill for that specific case). Still runs in
  the background service worker; the folder-per-module shape exists because these modules tend to
  need more than one file. Auto-discovered the same way as bundled `dom` Modules (see below), via a
  separate glob (`module-registry/background-modules.ts`) scoped to this folder.
- **With `dom`:** `src/adapters/browser-extension/content-scripts/modules/<kebab-case-name>.module.ts`
  — runs in the page context, which is specific to the browser-extension Adapter. It cannot call
  `ai`/`net`/`cache` services directly (background owns those, and content scripts are subject to
  the host page's CSP); if it needs one, it sends a message to background and awaits the response
  instead of touching `ctx.services` for anything but `bus`.

Create the relevant folder if it doesn't exist yet. If `src/kernel/` doesn't exist yet (Kernel not
bootstrapped — see `kernel-bootstrap` skill), still scaffold the module against the
`Module`/`Capability` shape below as a local type stub; don't block module creation on the Kernel
existing.

**If `src/adapters/browser-extension/module-registry/bundled-modules.ts` exists** (the
`module-registry` skill has been applied), placing a `.module.ts` file in
`content-scripts/modules/` is *all* that's needed — it's auto-discovered via
`import.meta.glob` and auto-registered in `content-scripts/index.ts`. Do **not** manually add an
import/`registerDomModule(...)` call anywhere; that file no longer hand-registers Modules and
adding a duplicate registration would double-dispatch. The new Module also appears in the popup
automatically, with its declared `needs[]` auto-granted (bundled Modules are trusted build-time
code). Only fall back to the manual `registerDomModule(YourModule)` pattern described below if
`bundled-modules.ts` doesn't exist yet.

## Template — simple module (needs: [] or ['net'] only)

```ts
import type { Module } from '../kernel/module';

export const <Name>Module: Module<InputT, OutputT> = {
  id: '<kebab-case-name>',
  needs: [/* 'net' if it fetches, else empty */],
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

## Template — `dom` module (content script)

```ts
import type { Module } from '../../../../kernel/module';

export const <Name>Module: Module<InputT, OutputT> = {
  id: '<kebab-case-name>',
  needs: ['dom'],
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
- **Don't add `supportedEnvs`** to a scaffolded Module unless the user explicitly targets a
  non-browser runtime — omitting it defaults to `['browser-extension']` (the Environment Guard in
  `src/kernel/environment-guard.ts` handles this), which is correct for every Module today.
- Keep `run()` `async` even if the body is fully sync, for uniform Kernel scheduling.
- After scaffolding, report which capabilities were declared and why, so the user can catch an
  over-declared module early. For a `dom` module under auto-discovery, also mention that no manual
  wiring is needed and that it'll show up in the popup once the extension reloads.
