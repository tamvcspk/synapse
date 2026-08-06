# Glossary — the domain nouns

Synapse's vocabulary is precise and several nouns look interchangeable but are not. This file is a
**router**, like [INDEX.md](INDEX.md): a one-line definition, where the noun lives in code, and
where to read more. It does not explain *how* to build anything — that's what the skills are for,
and a feature's business rules live in that feature's own `.domain.md`.

**Rule of thumb:** if two nouns below feel like synonyms, read the "Not to be confused with" line.
Every pair listed there has caused a real design mistake in this repo.

---

## Units of work

### Module
A unit with `id` + `run(input, ctx)`, discovered at **build time** and shipped inside the extension.
Declares `needs` (which Services get injected) and `scopes` (what it's permitted to do).
📁 `features/<name>/*.background.ts` or `*.module.ts` · 📖 `module-scaffold` skill

> **Not to be confused with Script.** A Module is trusted first-party code; its `scopes` are granted
> automatically by derivation, never stored. A Script is untrusted and starts with zero grants.

### Script (user script)
A `.js` file the user uploads or writes in Studio at **runtime**, registered via
`chrome.userScripts` into the USER_SCRIPT world. Declares itself with a `__synapseModule` global.
Identity is a UUID the extension assigns *before* the code ever runs — the script's self-declared
`id` is a display label only, never a routing or storage key.
📁 stored in `chrome.storage.local`, not in the repo · 📖 `module-registry` skill, `docs/user-scripts.md`

### Composite Module / Pipeline / Step
A Module whose work is an ordered array of **Steps** (`{id, label?, run}`) executed sequentially,
output feeding input. A plain single-`run()` script **is** a pipeline of one step — not a different
kind of thing. Failure of one step is caught and the previous value flows on; there is no rollback.
📁 `src/kernel/composite-module.ts` · 📖 `docs/design.md` §13

> **Not to be confused with Workflow.** A Workflow (`{id, steps: string[]}`) orders *separate
> Modules* by id; a Composite Module's steps are functions *inside one* Module.

### Feature
A directory under `features/` grouping everything one product capability needs, across every
execution context. **Feature names map 1:1 onto scope names** — that alignment is the reason the
axis exists.
📁 `src/adapters/browser-extension/features/<name>/` · 📖 `sdk-layers` skill, each `.domain.md`

---

## Permission

### Scope
What a Module or Script asks to be *allowed to do*, named after purpose/resource (`storage.rw`,
`net.request`), **never after a transport**. The catalog in `src/kernel/scopes.ts` is the only
authority — never trust a list of scope names written in prose.
📖 `userscript-api` skill · `docs/design.md` §3.E, §12

> **Not to be confused with Capability (`needs`).** `needs` is build-time dependency injection —
> which Services land in `ctx.services`. It is not permission and is never shown to the user.
> `bus` can be a Capability but must never be a Scope: it reaches every Module's listener, so
> "allow bus?" is a question no user can answer.

### Enforced vs Disclosed
Two classes of Scope, **never merged in the consent UI**. *Enforced* = `synapseApi` is the only way
to do it, so refusing really closes a gate. *Disclosed* = the script can do it anyway, so listing it
is transparency. Presenting a Disclosed scope as a gate is a consent UI that lies.
Classification depends on the **Container**, and is decided at implementation time — it has been
mispredicted at planning time more than once.

### Grant
The stored decision `{scopes, sourceHash}` for one uploaded Script. Bundled Modules have no stored
grant — theirs is derived from code on every read. A grant is **(action × resource)**: a
network-touching scope carries `match` patterns, so the consent line names real domains.
📁 `module-registry/storage.ts` · 📖 `userscript-api` skill

### Secret
A named credential the platform substitutes **at the network boundary**. A Script only ever holds
the *name* (`secretRef`), never the value — there is no API that returns one, by design.
📁 `features/secrets/` · 📖 `features/secrets/.domain.md`

---

## Execution environment

### World
Chrome's JS isolation boundary. Three matter here, and **they share the DOM but no JS state**:
- **MAIN** — the page's own JS. Where the page's real `window.fetch` lives. Zero `chrome.*`.
- **ISOLATED** — content scripts. Extension's own copies of every global.
- **USER_SCRIPT** — uploaded scripts. One world per page **shared by every script**, which is why
  the API is passed as `ctx.api` and never published on a global.

> Anything two worlds must agree on has to be expressed in the **DOM** and re-derived from it —
> there is no shared registry, counter, or lock to coordinate through.

### Execution context
Where a file runs, declared by its **filename suffix** (`.background.ts` / `.content.ts` /
`.page.ts` / `.offscreen.ts`). Load-bearing, not decoration: it is also what the auto-discovery
globs match, and each context has different `chrome.*` available.
📖 [INDEX.md](INDEX.md) has the full table

### Transport
How a call reaches an implementation: in-process, content-script RPC, or the uploaded-script shim.
One `synapseApi` interface, three transports — a method present on one but not another is a
**contract break**, not a gap. Identity always comes from the transport, never from an argument.
📁 `module-registry/rpc-handler.ts` (the sole enforcement point) · 📖 `userscript-api` skill

---

## UI

### Surface
A slot of screen space the compositor allocates to one owner — `toast`, `icon`, or `badge`. A script
never receives a node in shared space; it requests a surface and Core positions it. The real key is
`<ownerId>:<localId>` with `ownerId` assigned by the platform.
📁 `utils/ui-compositor.ts`, `shared/ui/surface-policy.ts` · 📖 `in-page-ui-engine` skill

### Container
*Where* a script's UI is hosted: **A** floating Shadow-DOM on the page (built), or **B** a sandboxed
iframe with its own document (planned). The container decides whether `page.dom` is Enforced or
Disclosed — in A the script already has the DOM, in B it has none.
📖 `docs/ROADMAP.md` Phase 7

### UI surface (the other meaning)
Which *extension* screen a feature belongs on: Popup, Dashboard tab, in-page overlay, or Side Panel.
Unrelated to "Surface" above despite the shared word.
📖 `ui-surface-placement` skill

---

## Extension points

### Slot (pipeline hook)
A named override point the **platform** declares inside its own pipeline. A Script registers a
handler with a `match` pattern; the handler runs in the script's own world so closures work. On
conflict, the more specific `match` wins — **never registration order**.
📁 `shared/pipeline-hook-bridge.ts` · 📖 `docs/design.md` §12

### Template
A small self-contained `.js` shipped in the extension as a starting point for a new Script. Cloning
a bundled Module produces a template, **never a copy of its TypeScript source**. Each template's
opening comment states honestly what it cannot yet do — making it a live gap report for `synapseApi`.
📁 `ui/studio/templates/` · 📖 `docs/design.md` §13

### `synapseApi`
The single facade every Module and Script programs against — **the only surface with users outside
this repo**, and therefore the only one that gets stability guarantees. The Kernel is an internal
detail by comparison.
📁 `src/kernel/synapse-api.ts` (type) · `docs/types/synapse-userscript.d.ts` (generated)
📖 `userscript-api` skill, `docs/api-inventory.md`
