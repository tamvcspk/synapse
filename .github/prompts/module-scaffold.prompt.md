---
mode: agent
description: Scaffold a new Synapse Module following the Kernel + Capability Declaration pattern (docs/design.md).
---

Create a new Synapse Module. A Module's complexity must be exactly proportional to what it
declares in `needs[]` — don't add machinery it didn't ask for.

Ask for whatever's missing: purpose (one sentence), capabilities needed (`net`, `ai`, `cache`,
`bus`, `dom`, or none — if the task is a deterministic fetch/parse/transform, the answer is `none`
or `['net']`; resist adding `ai`/`bus` unless it genuinely needs AI judgment or cross-module
coordination), and rough input/output shape.

`dom` is special: it means this Module must run as a **content script** (the background service
worker has no DOM access). Confirm it's really needed before adding it.

Placement:
- No `dom`: `src/modules/<kebab-case-name>.module.ts` (background context) — Adapter-agnostic,
  depends only on `kernel/module` Ports.
- With `dom`: `src/adapters/browser-extension/content-scripts/modules/<kebab-case-name>.module.ts`
  — cannot call `ai`/`net` services directly (background owns those; content scripts are also
  subject to the host page's CSP); route through a message to background instead if needed.

Don't add `supportedEnvs` unless the user explicitly targets a non-browser runtime — omitting it
defaults to `['browser-extension']`, the only Adapter that exists (docs/design.md §8 lists the
rest as an unbuilt roadmap).

If `src/kernel/` doesn't exist yet, still scaffold against the `Module`/`Capability` shape as a
local type stub — don't block on the Kernel existing (use `/kernel-bootstrap` for that).

Template (simple, `needs: []` or `['net']`):
```ts
import type { Module } from '../kernel/module';

export const <Name>Module: Module<InputT, OutputT> = {
  id: '<kebab-case-name>',
  needs: [],
  async run(input) {
    return output;
  },
};
```

Template (with capabilities):
```ts
import type { Module } from '../kernel/module';

export const <Name>Module: Module<InputT, OutputT> = {
  id: '<kebab-case-name>',
  needs: ['ai', 'cache'],
  async run(input, ctx) {
    const cached = await ctx.services.cache.get(input.key);
    if (cached) return cached;
    const result = isSimpleCase(input) ? ruleBasedLogic(input) : await ctx.services.ai.ask(input);
    await ctx.services.cache.set(input.key, result);
    return result;
  },
};
```

Template (`dom`, content script):
```ts
import type { Module } from '../../../../kernel/module';

export const <Name>Module: Module<InputT, OutputT> = {
  id: '<kebab-case-name>',
  needs: ['dom'],
  async run(input) {
    const value = document.querySelector(input.selector)?.textContent;
    return { value };
  },
};
```

Only destructure `ctx.services.X` for an `X` actually in `needs`. Don't add an
`isSimpleCase`/AI-fallback branch unless the task is genuinely ambiguous — most templates show it
for reference, not because every Module needs it. Keep `run()` `async` even when fully
synchronous. After scaffolding, report which capabilities were declared and why.
