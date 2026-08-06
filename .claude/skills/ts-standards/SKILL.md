---
name: ts-standards
description: TypeScript conventions and best-practice defaults for Synapse (strictness, module boundaries, async shape, error handling, schema validation, tooling). Apply when writing or reviewing any .ts file in this project, and when scaffolding new modules or kernel code.
---

# TypeScript Standards for Synapse

Synapse ships as a **browser extension (Manifest V3)** — see `docs/design.md` section 7. There is
no Node.js runtime in production: nothing in `src/` may import Node-only APIs (`fs`, `path`,
`process`, `child_process`, etc.). `fetch()` here means the extension context's `fetch`, never a
Node HTTP client. (`@types/node` is a devDependency for `node:vm`/`node:fs` **in tests only**.)

## Toolchain — what is actually installed

Read `package.json` for versions; this is the shape, not a wish list.

- **Target:** MV3 browser extension. Entry points: `background` (service worker, hosts the Kernel),
  `content-scripts`, and several extension pages (`popup`, `dashboard`, `side-panel`, `studio`,
  `help`, `review`, `offscreen`) — the pages beyond popup are **manual Rollup inputs** in
  `vite.config.ts`, since no manifest field covers a page opened via `chrome.tabs.create`.
- **Package manager: npm** (`package-lock.json`). Not pnpm/yarn.
- **Bundler:** Vite + `@crxjs/vite-plugin`. Build only — no Node step at runtime.
- **Chrome types:** `@types/chrome` for every `chrome.*` call — never `any`-cast extension APIs.
  When the pinned types lag a shipped API, add a scoped `declare global` augmentation next to the
  call site rather than casting.
- **NOT installed, do not assume:** `zod`, ESLint, Prettier. Validation of untrusted input is
  hand-rolled on purpose (`kernel/manifest-validator.ts`) — the input is `unknown` from outside the
  build, and the check is small and stable enough not to justify a dependency. **Don't add one of
  these without asking**; if `zod` ever does land for Bus/message schemas, revisit consolidating.

If any of this conflicts with what's actually in `package.json`, `package.json` wins — say so rather
than silently following this file.

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

Note `"lib"` includes `DOM` project-wide for convenience, but that doesn't mean every file may
touch DOM globals. **Which context a file runs in is declared by its filename suffix**
(`*.background.ts` / `*.content.ts` / `*.page.ts` / `*.offscreen.ts` — see `module-scaffold`), and
a service-worker or Offscreen file referencing `document`/`window` is a bug the type checker will
**not** catch. This has shipped for real: a bundler helper injected `document.head.appendChild`
into the service-worker bundle and only surfaced at runtime (docs/LESSONS.md, "Bundler giả định môi
trường có DOM"). Catch it in review, and grep `dist/` when in doubt.

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
  `include: ['src/**/*.test.ts']`. Safe from the bundle: the auto-discovery globs match specific
  context suffixes (`*.module.ts`, `*.background.ts`), so a `.test.ts` is never reachable from an
  entry point.
- **`environment: 'node'` is the default and should stay that way.** A test genuinely needing a DOM
  opts in per-file with a `// @vitest-environment jsdom` docblock. The moment the global default
  becomes browser-ish, a `src/shared/` file that accidentally reaches for `document` stops failing
  the way it should.
- **What is worth testing, in order:** `src/shared/` (pure by definition — no excuse not to), then
  `src/kernel/` (contracts + wiring), then a Module's own pure helpers. Code that only exists to
  call `chrome.*` is not unit-testable here and shouldn't be contorted into being so; it goes on
  the checklist in **`docs/TEST_PLAN.md`** instead, and if it's a `synapseApi` capability it also
  ships a `docs/examples/test-<feature>.js` the user can run against real Chrome.
- **Test the round trip, not the shape.** A test that asserts source *looks* right never catches
  a context-boundary bug. The two costliest bugs in this repo's history (an RPC bridge that could
  never return a result; messages routed to the wrong Chrome event) both survived review and unit
  tests because nothing simulated *both ends* — see docs/CHANGELOG.md §11.3.
- Simple Modules (no `needs`) are pure functions — test with plain unit tests, no Kernel involved.
- Modules using `ai`/`cache`/`bus` — test by constructing a `ModuleContext` with fake services
  directly (no need for a full `ServiceInjector`/`Kernel` in unit tests); reserve
  Kernel-in-the-loop tests for integration-level checks of the pipeline/bus wiring itself (see
  `kernel/workflow.test.ts`'s bus-registration case for the pattern).
