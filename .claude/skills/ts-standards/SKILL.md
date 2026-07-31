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
- **There is no runtime-env abstraction, and reintroducing one is out of scope.** `RuntimeEnv`,
  `Module.supportedEnvs`, and `kernel/environment-guard.ts` were removed after an audit found ~0%
  of the codebase could ever port (docs/design.md §8). Never write `chrome.*`-alternative code
  (`vscode.*`, `ipcRenderer`, Node `fs`), and never justify a design choice — an interface shape, a
  file's placement, an extra layer — by appealing to a hypothetical second Adapter. The reason
  `kernel/` and `shared/` stay `chrome.*`-free is that they must survive a MAIN-world import and
  run under `npm test` in plain Node; both are checkable, portability was not.

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

- **Runner: Vitest.** `npm test` (`vitest run`) / `npm run test:watch`. Config is `vitest.config.ts`
  — deliberately NOT `vite.config.ts`, whose crx plugin would otherwise drive a full MV3 build on
  every test run.
- **Tests are co-located** as `<file>.test.ts` next to what they test, and collected by
  `include: ['src/**/*.test.ts']`. Safe from the bundle: `bundled-modules.ts`/`background-modules.ts`
  glob `*.module.ts` / `*/index.ts`, so a `.test.ts` is never reachable from an entry point.
- **`environment: 'node'` is the default and should stay that way.** A test genuinely needing a DOM
  opts in per-file with a `// @vitest-environment jsdom` docblock. The moment the global default
  becomes browser-ish, a `src/shared/` file that accidentally reaches for `document` stops failing
  the way it should.
- **What is worth testing, in order:** `src/shared/` (pure by definition — no excuse not to), then
  `src/kernel/` (contracts + wiring), then a Module's own pure helpers. Code that only exists to
  call `chrome.*` is not unit-testable here and shouldn't be contorted into being so; that's what
  the "chưa verify bằng browser thật" list in docs/ROADMAP.md is for.
- Simple Modules (`needs: []` or `['net']`) are pure functions — test with plain unit tests, no
  Kernel involved.
- Modules using `ai`/`cache`/`bus` — test by constructing a `ModuleContext` with fake services
  directly (no need for a full `ServiceInjector`/`Kernel` in unit tests); reserve
  Kernel-in-the-loop tests for integration-level checks of the pipeline/bus wiring itself (see
  `kernel/workflow.test.ts`'s bus-registration case for the pattern).
