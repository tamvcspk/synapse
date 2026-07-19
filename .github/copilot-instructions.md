# Synapse — Copilot Instructions

Synapse is a personal automation/AI playground shipped as a **browser extension (Manifest V3)**.
Full architecture: [`docs/design.md`](../docs/design.md).

## Core architecture — read this before generating code

- **Kernel + Capability Declaration.** Every unit of work is a **Module**: `{ id, needs?:
  Capability[], supportedEnvs?: RuntimeEnv[], run(input, ctx) }`. `needs` is one or more of `net |
  ai | cache | bus | dom`. The **Kernel** (background service worker) reads `needs[]` and injects
  exactly the Services declared — nothing more.
- **Hexagonal Core/Adapter split.** `src/kernel/` is the platform-agnostic Core; everything
  `chrome.*`-specific lives under `src/adapters/browser-extension/`. A Module's `supportedEnvs`
  defaults to `['browser-extension']` — the only Adapter implemented. `RuntimeEnv` also has
  `'vscode' | 'electron' | 'node'` as **reserved, unimplemented** values (docs/design.md §8) —
  never write code for them unless separately asked.
- **Progressive Complexity.** A Module that only fetches/parses/transforms data declares `needs:
  []` or `['net']` and is a plain function — no Decision Engine, no Bus, no AI. Only reach for
  `ai`/`bus`/`cache` when the task genuinely requires AI judgment, cross-module coordination, or
  shared state. Don't scaffold agentic machinery for deterministic tasks.
- **Execution contexts matter.** Modules without `dom` run in the background service worker.
  Modules declaring `dom` **must** run as content scripts (background has no DOM access) and
  can't call `ai`/`net` services directly — they message the background instead.
- **MV3 lifecycle.** The background service worker is non-persistent — it can be killed and
  restarted between events. Never assume in-memory state survives; Cache/Session State are backed
  by `chrome.storage`, not plain objects/Maps.
- **No Node.js at runtime.** Nothing under `src/` may import `fs`, `path`, `process`, or other
  Node-only APIs — this is a browser extension end to end.

## Where to look for conventions

- TypeScript conventions (strictness, error handling, schema validation, testing) auto-apply to
  `*.ts` files via `.github/instructions/ts-standards.instructions.md`.
- For scaffolding tasks, use the matching prompt file in Copilot Chat:
  - `/module-scaffold` — new Synapse Module
  - `/kernel-bootstrap` — initial Kernel scaffold (once, when `src/kernel/` doesn't exist yet)
  - `/doc-sync` — build/refresh a documentation knowledge base under `kb/`

These mirror the Claude Code skills in `.claude/skills/` — keep both in sync if one changes.
