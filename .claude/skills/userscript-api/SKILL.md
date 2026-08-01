---
name: userscript-api
description: Design or extend `synapseApi` — the single facade object every Synapse Module programs against, whether it's a bundled Module, a dom Module, or a user-uploaded script — plus the scope-based permission model that gates it. Use when adding/changing any capability a user script can call, when touching the userScripts shim/RPC bridge, when wiring consent/grant UI, or when asked "how does a user script reach feature X".
---

# `synapseApi` — the one contract

Synapse's product is a userscript platform (docs/ROADMAP.md §11). `synapseApi` is the **public API
of that product**: the thing user scripts are written against. It is the only surface with real
external users, so it is the only surface that needs stability, versioning and docs. The Kernel is
an internal detail by comparison — don't invest in making `src/kernel/` reusable, invest in making
`synapseApi` stable.

## Guard — read before writing code

**Phase 2 is built** (docs/ROADMAP.md §11.3). `src/kernel/synapse-api.ts` (type-only, import-free)
+ `src/kernel/scopes.ts` (the catalog) exist — **extend them, don't redesign**. The v1 surface is
deliberately small: `storage.rw` (Enforced) plus `page.dom` / `page.fetch` (Disclosed). Everything
in the Catalog table below that isn't in `SCOPE_CATALOG` is Phase 5's job, not a gap to close on
sight.

Three things that are settled and should not be relitigated:

- `Module.needs` (`'ai' | 'cache' | 'bus'`) is **build-time DI**; `Module.scopes` is **permission**.
  They are separate fields on purpose — `bus` must never be a scope, but background Modules
  genuinely need it injected.
- Bundled grants are **derived from code on every read, never persisted**. Only uploaded scripts
  have a stored grant record, and `grantScopes()` refuses any id that isn't an uploaded script.
- `docs/types/synapse-userscript.d.ts` is **generated** (`kernel/userscript-dts.ts`, asserted by
  `userscript-dts.test.ts`). Editing it by hand fails the suite; regenerate with `npm test -- -u`.

## Shape

One interface, three transports. The interface lives in `src/kernel/` (no `chrome.*`); each
execution context supplies its own transport:

| Caller | Transport |
|---|---|
| background Module | in-process — call the service directly |
| dom Module (content script, ISOLATED) | `chrome.runtime.sendMessage` RPC (`content-scripts/rpc-client.ts`) |
| uploaded user script (USER_SCRIPT world) | same RPC, handed to `run()` as `ctx.api` by the shim |

Worlds stay isolated. The facade is **always delivered per call as `ctx.api`, never as a global** —
in any world. On the page's `window` it would hand every website full access; even in the
USER_SCRIPT world a global has one binding shared by every uploaded script, so the last one loaded
owns the name and everyone else's calls inherit its identity and grants. Either way the caller stops
being identifiable, which is the permission model's load-bearing assumption (see "Never" below).

## Three hard constraints

These come from `chrome.runtime.sendMessage`'s structured-clone boundary. They are not style
preferences — violating them produces silent failures, not type errors.

1. **Every method is `async`.** Including ones that feel synchronous. Background Modules pay an
   `await` for an in-process call; that uniformity is the price of one contract.
2. **No function-valued parameters, ever.** Functions do not survive structured clone — they arrive
   as `undefined` and the call silently no-ops. This is exactly how the retired `synapse.bus.on()`
   was broken. Subscriptions must be `onX(handler)` where the handler is registered **locally in the
   caller's world** and the transport only pushes serializable events across.
3. **No methods on returned values.** Return plain data. To model a live thing (a running download),
   return an id and expose sibling methods that take it.

## Scopes, not capabilities

The old `Capability = 'net'|'ai'|'cache'|'bus'|'dom'` model was retired because it could not
express meaningful consent:

- `bus` is a **god-capability**: `bus.emit(moduleId, payload)` reaches every bundled Module's own
  listener, so granting `bus` grants control of the whole extension. A consent prompt saying
  "allow bus?" is unanswerable.
- `net` and `dom` resolved to no service at all — declaring them was a silent no-op.

**The governing principle: permission by purpose/resource, never by transport mechanism.** A script
declares *what it wants to do* (`media.download`), not *which pipe it wants* (`bus`). Scopes are
dotted and named after the feature that serves them, so `features/<name>/` maps 1:1 onto `<name>.*`
(see `sdk-layers`).

### Two classes — never merge them in the consent UI

| Class | Definition | Does denying it do anything? |
|---|---|---|
| **Enforced** | The only way to do it is through `synapseApi` | ✅ Yes — the gate really closes |
| **Disclosed** | The script can do it anyway without your API | ❌ No — this is *transparency*, not a gate |

`page.dom` is the canonical Disclosed scope *when the script runs on the page*: it shares the page's
DOM, so `document.querySelector` works with zero permission from Synapse. Listing it next to
`media.download` as if refusal protected the user is **a consent UI that lies**. Render the two
groups separately, with different wording ("Sẽ bị chặn nếu từ chối" vs "Script vẫn làm được — khai
báo để bạn biết").

**Classification is not fixed — it depends on the container** (docs/ROADMAP.md §11.8,
`in-page-ui-engine`). A script hosted in a sandboxed iframe (own page / sidebar tab) has **no** page
DOM and must go through `page.*`, which makes `page.dom` genuinely **Enforced** there. So the same
scope name is Disclosed in the floating container and Enforced in the iframe container. The consent
UI must classify per (scope × container), not per scope alone — and this is a strong argument for
hosting a script in an iframe whenever it doesn't truly need to attach to the page.

### Catalog

`src/kernel/scopes.ts`'s `SCOPE_CATALOG` is the authority — this table is the *plan*, and the ✅
column says how much of it is real. Don't add a planned row on sight; add it when the phase that
owns the feature behind it arrives, so a scope never ships with nothing to gate.

**Enforced:**

| Scope | Consent line | Built |
|---|---|---|
| `storage.rw` | Store this script's own data *(namespaced — cannot read other scripts')* | ✅ Phase 2 |
| `ui.render` | Show UI on the page | Phase 3 |
| `media.read` | See the media detected on this page | Phase 5 |
| `media.download` ×match | Download media from **{domains}** | Phase 5 |
| `net.observe` ×match | See requests this page sends to **{domains}** *(URLs may carry tokens)* | Phase 5 |
| `net.mock` ×match | Block/modify requests to **{domains}** | Phase 5 |
| `ai.ask` | Send data to an AI model | Phase 5 |

**Disclosed** *(in the floating container only — Enforced in a sandboxed-iframe container):*
`page.dom` (read/modify page content) ✅ and `page.fetch` (make its own network calls, subject to
the page's CORS) ✅.

Adding an entry means: a row in `SCOPE_CATALOG` (with `consentLine` + `description` +
`requiresMatch`), its methods in `API_METHODS`, the method on `SynapseApi`, an implementation in
`synapse-api-host.ts`, and the same method on the shim and `rpc-client.ts`. `npm test -- -u`
regenerates the published `.d.ts`; nothing else needs touching for docs.

### Rules

- **A scope names something a user can decide about.** If you can't write a one-line consent string
  a technical user could reason about, it's too broad — split it.
- **Read and write are separate scopes.** `media.read` must not imply `media.download`.
- **Network-touching scopes carry a resource dimension.** A bare `media.download` means "fetch
  anything from anywhere under the extension's identity" — including header replay and the
  extension's request context. Declare as `{ scope, match: ['*://*.example.com/*'] }` and generate
  the consent string with the real domains in it. Precedent: Tampermonkey's `@connect` — a grant is
  (action × origin), not action alone.
- **Cap at ~10 scopes.** Past that, users click Allow on everything and the model collapses.
- **`bus` is never a scope.** It stays internal plumbing; facade methods replace it.
- Enforcement stays where it already is: **background re-checks every call** against persisted
  activation + grants (`module-registry/rpc-handler.ts`). The shim is never trusted to self-limit —
  it runs in a world the user's own code controls.

### Storage must be namespaced — non-negotiable

A grantable storage API over unnamespaced `chrome.storage.local` is a **privilege-escalation
primitive**, because the permission records themselves live in that store. This *was* a live hole:
`cache.set('synapse:grants', …)` let a script grant itself everything. Closed by `script-storage.ts`
(`script:<moduleId>:<userKey>`, `moduleId` from the transport, prefix prepended so no caller input
escapes) **and** by `rpc-handler.ts` no longer routing a raw key/value service at all. Keep both:
either alone would be one refactor away from reopening it. **Never expose a raw key-value store
across a permission boundary.**

Two implementation details worth not re-deriving: flat prefixed keys beat one nested blob (two
scripts writing concurrently would read-modify-write over each other, and a service worker can't
hold a lock across that); and a `moduleId` containing `:` is rejected, otherwise `{a, "b:c"}` and
`{"a:b", c}` address the same key.

### Grant lifecycle

- **Grants reset when a script's source changes** — implemented: the record is
  `{ scopes, sourceHash }` (SHA-256, `shared/source-hash.ts`), and `getGrantedScopes` returns `[]`
  on mismatch. Both the RPC handler and the Registry go through that one function so neither can
  skip the check. A mismatch can't happen yet (every `uploadModule` mints a fresh uuid); it's there
  so an "update script" path is safe by construction rather than by remembering.
- **Bundled modules' grants are derived from their own `Module.scopes` on every read, never
  persisted.** **Uploaded modules always default to `[]`**, and `grantScopes()` refuses any id
  that isn't in the uploaded map — the auto-grant branch has no *route* to an uploaded module,
  which is stronger than a convention not to take one.

## Secrets — reference-only, never readable

**If a script can read a secret, there is no security.** It has `fetch`; the next line exfiltrates.
A secret store that returns plaintext protects roughly as much as pasting the key into the source —
it changes where the value is kept, not who can read it. So:

- **The script never sees the value.** It names a `secretRef`; the platform substitutes it **at the
  network boundary** in background and returns only the response. Same shape as header replay
  (ROADMAP §7.1) — the extension knows headers the page/script never receives.
- **A secret is bound to allowed hosts at creation.** Otherwise the script points the request at its
  own server and the header goes along for the ride. Same (action × origin) shape as the network
  scopes.
- **Three deliberate absences.** No `secrets.read` scope *at all* — a scope that doesn't exist can't
  be granted by mistake; only `secrets.use`. No create/update/delete API — secret management is
  UI-only. No list API — even a secret's *name* is information; scripts declare the refs they need
  and get yes/no.
- **Plaintext at rest, and say so.** Encrypting with a key stored next to it is theater. A
  passphrase-derived key held in `chrome.storage.session` is real protection against profile theft
  but costs an unlock per session and kills unattended runs — opt-in later, not v1. Never claim
  protection the design doesn't provide; the whole permission model rests on not lying to the user.
- **Never ship a secret store before script-facing storage is namespaced.** Concentrating every API
  key into one store that scripts can already read turns a hole into a catastrophe.

Bonus property worth preserving: because a shared script contains only a *name*, scripts stay
shareable without leaking credentials, and the recipient gets a consent-shaped prompt to supply
their own value.

## Composition — three tiers, not a workflow engine

Multi-step automation is exposed progressively (docs/ROADMAP.md §11.6). Match the tier to the
problem; don't reach for the next one by default.

1. **A single `run()`.** Where most scripts stop. Already shipped.
2. **Hooks into platform pipelines** — for *"the pipeline shape is right, I want to change one step,
   and only on this site"*. That's Strategy + URL dispatch, **not** graph composition, and it's the
   shape almost every real request takes. Platform declares named slots; scripts register handlers
   with a `match` pattern. Handlers run in the script's own world, so closures work. Hooking a
   feature's slot requires that feature's scope.
   **Conflict resolution must be deterministic**: most-specific `match` wins, ties broken by
   user-configured order, **never registration order**. (Third time this rule appears — see also
   storage namespacing and UI surface identity. Any shared resource, same rule.)
3. **Linear composite** — `createCompositeModule` exposed to scripts. Sequential, output→input, per
   step bypass, graceful-fail per step, no rollback, no shared state outside input/output. Already
   built in `kernel/composite-module.ts`; the gap is only that the shim doesn't expose it.

**A DAG/workflow engine is deliberately out of scope** (ROADMAP Open Points records the reasoning
and the re-entry criteria). Two things to remember if someone proposes one again: in a sequential
pipeline of JS functions, branching is `if` and looping is `for` *inside a step* — an explicit graph
only pays off if something consumes the structure; and nodes spanning execution contexts turn every
edge into a `structured-clone` boundary, which the best-working pipeline in the repo could not
survive (see below).

**Invariant to protect: a pipeline's steps share one execution context.** `reader-mode-converter`
passes a live `Document` through all four of its steps. That works *only* because they all run in
the content script. Any proposal to let steps live in different contexts must first answer what
happens to values that cannot be cloned — and "pass a handle instead" is a change to every step's
signature, not a detail.

## Docs are generated, never hand-maintained

Users of this API will mostly write scripts with an AI assistant. That makes documentation a
feature, and it makes **drift actively dangerous**: hand-written docs fall behind `synapseApi` within
weeks, and stale docs fed to an LLM produce confidently wrong code that the user cannot diagnose.

One source, three outputs — no fourth. The scope/method catalog already carries a `description` for
each entry because the consent UI requires human-readable text anyway, so generation is close to
free:

```
SynapseApi catalog (+description) ─┐
docs/user-scripts.md (concepts)    ├─ build ─┬─► in-extension Help page (HTML)
LESSONS.md (user-facing subset)   ─┘         ├─► docs/types/synapse-userscript.d.ts
                                              └─► synapse-ai-context.md (downloadable)
```

- **Put "things that fail silently" *before* the API reference** in the AI bundle. An LLM already
  knows JavaScript; what it doesn't know is this platform's traps, and it will confidently emit
  `bus.on(handler)`, a `<style>` tag, a function passed as an argument, or `chrome.*` inside a
  sandboxed frame — all of which fail with no error. Negative constraints carry more value per token
  than positive listings.
- **Stamp the version.** A stale bundle is worse than none.
- **Render at build time**; don't ship a markdown parser into an extension page.
- **Do not hand users the skills in `.claude/skills/`.** Those describe how to *build Synapse*
  (`sdk-layers`, `kernel-bootstrap` are about this repo's internal layout) — an assistant fed them
  will tell a user to create `src/kernel/` when all they wanted was one `.js` file. The user-facing
  bundle is a separate artifact written from the opposite side of the API.
- **Don't generate an agent file.** Users write their own for whatever tool they use.

## Adding a method — checklist

1. Method on the interface in `src/kernel/synapse-api.ts` — **type-only, import-free**: a runtime
   value or an `import` there breaks the `.d.ts` generator, which copies the file verbatim from its
   `@userscript-dts:begin` marker.
2. Entry in `API_METHODS` (and, for a new scope, `SCOPE_CATALOG`) in `src/kernel/scopes.ts`. A
   method absent from `API_METHODS` is rejected at the boundary — the router is fail-closed.
3. Implementation in `module-registry/synapse-api-host.ts` (delegating to the owning feature).
   Enforcement is not written per-method: `rpc-handler.ts` derives it from the catalog.
4. Expose on the shim (`user-script-shim.ts`) and on the dom-Module builder (`rpc-client.ts`) — a
   method missing from one transport is a contract break, not a gap.
5. `npm test -- -u` to regenerate `docs/types/synapse-userscript.d.ts`.
6. `docs/user-scripts.md` — an example that actually runs.

Consent copy comes free from step 2's `consentLine`; so do the published docs. Steps 4–6 are not
optional polish: a method reachable from one context but not another, or absent from the `.d.ts`,
is how a public API rots.

## Never

- **Never expose `bus` to user scripts.** It defeats scoping entirely.
- **Never put the facade on a global — any global, in any world.** On MAIN-world `window`, page JS
  gains the same access. Even in the USER_SCRIPT world, one binding is shared by every uploaded
  script, so the last one evaluated owns it and every other script calling through it runs under
  that script's `moduleId` and grants. `sender` identifies a frame, not a script, so nothing
  downstream can catch the substitution. Pass it as `ctx.api`; leave a rejecting stub on the old
  name so pre-existing scripts fail loudly rather than impersonating a neighbour.
- **Never trust `needs`/scopes self-declared by an uploaded script** as authorization. It's a
  *request*; the grant record in `chrome.storage` is the authority.
- **Never let an uploaded script's own `__synapseModule.id` become a routing key** — the extension
  assigns the canonical id at upload time, before the script has ever run.
- **Never emit shim source with anything at top level.** Every registered script shares one
  `USER_SCRIPT` world per page, so a top-level `const` in the shim makes the *second* script on a
  page die with a redeclaration `SyntaxError` — the platform ran exactly one user script until this
  was found. The whole shim, user source included, goes in one **synchronous** IIFE (async would let
  one script's `globalThis.__synapseModule` snapshot land after another script overwrote it).

## Audience

Technical users who write code (docs/ROADMAP.md §11). Optimize for a precise, honest API over a
forgiving one: surface real errors, don't silently degrade. Sharing scripts is the user's own
decision (Tampermonkey-style policy) — the platform's job is making permissions **legible and
per-script**, not preventing sharing.

## See also

- `docs/LESSONS.md` — "MV3 message passing / relay" (broadcast semantics, response races) and
  "Chrome extension UI injection" (`chrome.userScripts` undefined until the user enables it).
- `module-registry` skill — registry/consent/upload mechanics this API is gated by.
- `in-page-ui-engine` skill — the `ui.*` scope's implementation rules.
