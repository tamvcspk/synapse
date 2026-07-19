---
name: ts-standards
description: TypeScript conventions and best-practice defaults for Synapse (strictness, module boundaries, async shape, error handling, schema validation, tooling). Apply when writing or reviewing any .ts file in this project, and when scaffolding new modules or kernel code.
---

# TypeScript Standards for Synapse

Synapse ships as a **browser extension (Manifest V3)** — see `docs/design.md` section 7. There is
no Node.js runtime in production: nothing in `src/` may import Node-only APIs (`fs`, `path`,
`process`, `child_process`, etc.), including Modules that only declare `net` — `net` means
`fetch()` from an extension context, not a Node HTTP client.

## Runtime & tooling assumptions (confirm before relying on these)

- **Target:** Manifest V3 browser extension — three entry points: `background` (service worker,
  hosts the Kernel), `content-scripts` (for Modules declaring `dom`), `popup`/`options` (UI).
- **Package manager:** pnpm, unless a lockfile for another one already exists.
- **Bundler:** Vite with an MV3-aware plugin (e.g. `@crxjs/vite-plugin`), or plain esbuild with
  separate entry points per context — whichever is already configured; don't assume a Node
  build step runs at runtime, only at build time.
- **Chrome types:** `@types/chrome` for every `chrome.*` API call — never `any`-cast extension
  APIs.
- **Schema validation (Schema-First principle in docs/design.md):** use `zod` to define Context Frame
  and Bus message schemas — parse at the Bus boundary (`schema.parse(payload)`), not deep inside
  Modules. This matters more here than in a typical app: Bus messages that cross the
  background/content-script boundary go through `chrome.runtime` serialization, so validate
  after deserialization, not just at the call site.
  - **Exception:** validating a runtime-uploaded module's self-reported manifest (see the
    `module-registry` skill) uses a hand-rolled checker (`kernel/manifest-validator.ts`), not
    `zod` — that input is `unknown` from outside the build entirely (no `zod` dependency exists in
    the project yet), and the check is small/stable enough not to justify adding one. If `zod`
    does get added for Bus/Context Frame validation later, reconsider whether it's worth
    consolidating.
- **Lint/format:** ESLint + Prettier, no custom rule authoring until there's enough code to know
  what actually needs enforcing.

If any of these conflict with a choice the user has already made elsewhere in the project, defer
to the existing choice and flag the mismatch rather than silently overriding it.

## External library docs before implementation

If a code plan under this skill introduces or touches a specific external library/SDK/API (beyond
the toolchain assumptions above), evaluate the `doc-sync` skill's "Auto-invocation from other
skills" checklist before writing implementation code against it — that skill owns the criteria for
when a local KB (`kb/<library>/<version>/`) is warranted and how to confirm with the user first.
Don't apply this to the stack already named above (chrome APIs, zod, ESLint/Prettier) — it's for
new, version-sensitive dependencies entering the plan.

## tsconfig baseline

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["chrome"]
  }
}
```

Note `"lib"` includes `DOM` project-wide for convenience, but that doesn't mean every Module may
touch DOM globals — only Modules declaring `dom` (i.e. code meant to run as a content script)
should actually reference `document`/`window`. Background-context code referencing DOM globals is
a bug the type checker won't catch for you; catch it in review.

## Conventions

- **`interface` for contracts, `type` for unions/aliases.** `Module`, `ModuleContext`,
  `AiService` etc. are `interface` (open to extension); `Capability`, result unions are `type`.
- **Named exports only** — no `export default`. Keeps grep/refactor and auto-import reliable.
- **`run()` is always `async`**, even when the body is fully synchronous — the Kernel schedules
  uniformly and shouldn't special-case sync Modules.
- **No `any`.** If a Module genuinely doesn't know its input/output shape yet, use `unknown` and
  narrow, not `any`.
- **Modules import only from `kernel/module`** (the public contract), never from
  `kernel/service-injector` or `kernel/scheduler` internals. That boundary is what keeps a Module
  swappable without touching the Kernel.
- **`RuntimeEnv` has reserved values you must not act on.** `'vscode' | 'electron' | 'node'` exist
  in the type (`kernel/module.ts`) only so the Environment Guard (`kernel/environment-guard.ts`)
  can reject a mismatched Module by name — there is no Adapter behind them (docs/design.md §8).
  Never write `chrome.*`-alternative code (e.g. `vscode.*`, `ipcRenderer`, Node `fs`) gated on one
  of these values; that would be building an Adapter that doesn't exist yet, which is out of scope
  unless separately requested.

## Error handling

- Modules throw a typed error, not a generic `Error`:
  ```ts
  export class ModuleError extends Error {
    constructor(public moduleId: string, message: string, public cause?: unknown) {
      super(`[${moduleId}] ${message}`);
    }
  }
  ```
- The Kernel/Scheduler is the only place that catches at the boundary between Modules — it logs
  (per the Observability principle) and decides whether to abort the pipeline or continue,
  depending on what the calling Workflow needs. Don't swallow errors silently inside a Module.
- Only validate/guard at real boundaries: Bus message ingress, external fetch responses (`doc-sync`
  style Modules), user-supplied config. Don't add defensive checks for states the type system
  already rules out.

## Testing

- Simple Modules (`needs: []` or `['net']`) are pure functions — test with plain unit tests, no
  Kernel involved.
- Modules using `ai`/`cache`/`bus` — test by constructing a `ModuleContext` with fake services
  directly (no need for a full `ServiceInjector`/`Kernel` in unit tests); reserve
  Kernel-in-the-loop tests for integration-level checks of the pipeline/bus wiring itself.
