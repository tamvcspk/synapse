# Codebase Index

**Generated — do not edit by hand.** Regenerate with `npm test -- -u` after adding, removing, or
renaming a source directory. The structure columns come from the filesystem; the Role column comes
from `AREA_DESCRIPTIONS` in [`src/kernel/repo-index.test.ts`](../src/kernel/repo-index.test.ts).

Read this **before** grepping — it tells you which directory to open. For what the domain nouns
*mean*, see [GLOSSARY.md](GLOSSARY.md). For a feature's business rules, read the `.domain.md` in
that feature's own folder.

25 source directories · 148 source files · 40 co-located test files.

## The three-layer rule

| Layer | Path | May import | Enforced by |
|---|---|---|---|
| Core | `src/kernel/` | `src/shared/` only | no `chrome.*`, no DOM, no I/O |
| Global SDK | `src/shared/` | nothing outside itself | must survive a MAIN-world import |
| Adapter | `src/adapters/browser-extension/` | anything | the only Adapter that will ever exist |

## Execution context suffixes

A filename suffix declares which context a file runs in — and it is also what the auto-discovery
globs match, so it is load-bearing, not decoration.

| Suffix | Runs in | `chrome.*` available |
|---|---|---|
| `*.background.ts` | service worker | all |
| `*.content.ts` | content script (ISOLATED) | messaging + storage |
| `*.module.ts` | content script, auto-registered as a Module | via `ctx.api` |
| `*.page.ts` | MAIN world of the real page | **none** |
| `*.offscreen.ts` | Offscreen Document | **only `chrome.runtime`** |
| *(no suffix)* | more than one context | varies — check callers |

## Map

| Directory | Files | Tests | Contexts | Role | Owner |
|---|---|---|---|---|---|
| `src/adapters/browser-extension/background` | 2 | — | — | Composition root for the service worker — constructs the Kernel and wires every background listener | `kernel-bootstrap` |
| `src/adapters/browser-extension/background/services` | 2 | — | — | Concrete `chrome.*`-backed implementations of the Kernel Ports (cache, bus) | `kernel-bootstrap` |
| `src/adapters/browser-extension/content-scripts` | 4 | — | — | Composition root for the content script + the RPC client that gives dom Modules `ctx.api` | `module-registry` |
| `src/adapters/browser-extension/features/http-mock` | 6 | — | MAIN world, background | Request interception across three mechanisms (main-world patch, CDP debugger, declarativeNetRequest) | `features/http-mock/.domain.md` |
| `src/adapters/browser-extension/features/media` | 13 | 1 | MAIN world, background, content | Media detection (webRequest, DOM, MSE/HLS hooks) and the network sniffer Module | `features/media/.domain.md` |
| `src/adapters/browser-extension/features/media/download` | 12 | 1 | background, offscreen | Download engine: VOD/live/turbo jobs, segment pipeline, OPFS staging, ffmpeg remux | `features/media/.domain.md` |
| `src/adapters/browser-extension/features/reader-mode` | 1 | — | Module | Page/site → Markdown converter, a 4-step Composite Module | `features/reader-mode/.domain.md` |
| `src/adapters/browser-extension/features/secrets` | 3 | — | background | Reference-only secret store; scripts never read a value, only name one | `features/secrets/.domain.md` |
| `src/adapters/browser-extension/module-registry` | 21 | 10 | — | Module discovery, uploaded-script lifecycle, the shim, and `rpc-handler.ts` — the sole permission enforcement point | `module-registry` |
| `src/adapters/browser-extension/ui` | 7 | — | — | Shared glue across extension pages — collection data sources, icons, path constants | `ui-surface-placement` |
| `src/adapters/browser-extension/ui/dashboard` | 2 | — | — | Standalone tab hosting a Collection-schema Module’s management UI, scoped by `?moduleId=` | `ui-surface-placement` |
| `src/adapters/browser-extension/ui/dashboard/views` | 3 | — | — | Generic management table, item form, and the bundled Composite Module steps view | `module-registry` |
| `src/adapters/browser-extension/ui/help` | 2 | — | — | Offline in-extension docs, rendered from `docs/user-scripts.md`; downloads the AI context bundle | `userscript-api` |
| `src/adapters/browser-extension/ui/offscreen` | 2 | — | — | Offscreen Document host — runs the download engine headlessly; only `chrome.runtime` exists here | `sdk-layers` |
| `src/adapters/browser-extension/ui/popup` | 2 | — | — | Toolbar popup: module list, toggles, grant, script lifecycle actions | `ui-surface-placement` |
| `src/adapters/browser-extension/ui/popup/views` | 6 | — | — | One file per popup view — in-flow view swap, never `<dialog>` | `module-registry` |
| `src/adapters/browser-extension/ui/review` | 1 | — | — | Full-page review of a reader-mode result, with ZIP export | `ui-surface-placement` |
| `src/adapters/browser-extension/ui/side-panel` | 2 | — | — | Side panel: detected media, download progress/resume, reader-mode results for the current tab | `ui-surface-placement` |
| `src/adapters/browser-extension/ui/studio` | 4 | — | — | Monaco-based script editor: edit, save, rename, step sidebar, Dry Run, templates | `module-registry` |
| `src/adapters/browser-extension/utils` | 6 | — | — | Mechanism shared by ≥2 features only: DNR rules, OPFS, blob store, offscreen manager, UI compositor, injector | `sdk-layers` |
| `src/adapters/browser-extension/utils/main-world` | 3 | — | — | MAIN-world mechanism with zero `chrome.*`: event channel, fetch/XHR patch, storage relay | `main-world-interceptor` |
| `src/kernel` | 15 | 8 | — | Core contracts: `Module`, Services (Ports), Scheduler, scope catalog, `synapseApi` type, doc generators | `kernel-bootstrap` |
| `src/shared` | 20 | 11 | — | Global SDK — pure functions, zero side effects; the only layer a MAIN-world payload may import | `sdk-layers` |
| `src/shared/download` | 8 | 8 | — | Pure half of the download engine: ordering, byte ranges, retry policy, checkpoints, HLS crypto/segment math | `sdk-layers` |
| `src/shared/ui` | 1 | 1 | — | Pure surface-allocation policy for the in-page compositor (quota, ownership keys, insertion order) | `in-page-ui-engine` |
