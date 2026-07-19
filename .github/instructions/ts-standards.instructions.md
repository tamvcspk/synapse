---
applyTo: "**/*.ts,**/*.tsx"
description: TypeScript conventions for Synapse — a Manifest V3 browser extension, no Node.js at runtime.
---

# TypeScript Standards for Synapse

Synapse ships as a **browser extension (Manifest V3)** — see `docs/design.md` §7. Nothing under
`src/` may import Node-only APIs (`fs`, `path`, `process`, `child_process`, ...) — including
Modules that only declare `net`, since `net` means `fetch()` from an extension context.

## Assumptions (defer to the repo's actual config if it differs)

- Three entry points: `background` (service worker, hosts the Kernel), `content-scripts`
  (Modules declaring `dom`), `popup`/`options` (UI).
- Bundler: Vite + an MV3-aware plugin (e.g. `@crxjs/vite-plugin`) or esbuild with per-context
  entries. `@types/chrome` for every `chrome.*` call — never `any`-cast extension APIs.
- Schema validation via `zod` for Context Frame and Bus messages — validate **after**
  deserialization at the Bus boundary (messages crossing background/content-script go through
  `chrome.runtime` serialization), not just at the call site.
- Package manager: pnpm unless a different lockfile is already present.

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

`lib` includes `DOM` project-wide for convenience, but only code meant to run as a content script
(Modules declaring `dom`) should actually touch `document`/`window`. Flag any background-context
code that references DOM globals — the type checker won't catch that for you.

## Conventions

- `interface` for contracts (`Module`, `ModuleContext`, `AiService`), `type` for unions/aliases
  (`Capability`, result unions).
- Named exports only — no `export default`.
- `run()` is always `async`, even when the body is fully synchronous.
- No `any` — use `unknown` and narrow when a shape is genuinely not known yet.
- Modules import only from `kernel/module` (the public contract), never from
  `kernel/service-injector` or `kernel/scheduler` internals.
- `RuntimeEnv` has reserved values (`'vscode' | 'electron' | 'node'`) with no Adapter behind them
  — they exist only so the Environment Guard (`kernel/environment-guard.ts`) can reject a
  mismatched Module by name. Never write `vscode.*`/`ipcRenderer`/Node `fs` code gated on one of
  these; that's building an unrequested Adapter (docs/design.md §8).

## Error handling

- Modules throw a typed `ModuleError` (`{ moduleId, message, cause }`), not a generic `Error`.
- The Kernel/Scheduler is the only place that catches at the boundary between Modules — it logs
  and decides whether to abort or continue the pipeline. Don't swallow errors inside a Module.
- Validate only at real boundaries: Bus ingress, external fetch responses, user-supplied config.
  Don't add defensive checks for states the type system already rules out.

## Testing

- Simple Modules (`needs: []` / `['net']`) are pure functions — plain unit tests, no Kernel
  involved.
- Modules using `ai`/`cache`/`bus` — construct a `ModuleContext` with fake services directly;
  reserve Kernel-in-the-loop tests for integration checks of the pipeline/Bus wiring itself.
