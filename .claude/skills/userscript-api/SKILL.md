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

As of docs/ROADMAP.md §11 this is **planned, not built**. What exists today:
`user-script-shim.ts` builds a `globalThis.synapse = { ai, cache, bus }` with 5 methods, gated by
5 coarse capabilities. §11 Phase 2 replaces that. Check `src/kernel/synapse-api.ts` — if it doesn't
exist, you're building Phase 2; if it does, extend it, don't redesign it.

## Shape

One interface, three transports. The interface lives in `src/kernel/` (no `chrome.*`); each
execution context supplies its own transport:

| Caller | Transport |
|---|---|
| background Module | in-process — call the service directly |
| dom Module (content script, ISOLATED) | `chrome.runtime.sendMessage` RPC (`content-scripts/rpc-client.ts`) |
| uploaded user script (USER_SCRIPT world) | same RPC, injected as a global by the shim |

Worlds stay isolated. `synapseApi` is a **facade over messaging**, never a MAIN-world global —
putting it on the page's `window` would hand every website full access and make the caller
unidentifiable, which destroys the permission model (see "Never" below).

## Three hard constraints

These come from `chrome.runtime.sendMessage`'s structured-clone boundary. They are not style
preferences — violating them produces silent failures, not type errors.

1. **Every method is `async`.** Including ones that feel synchronous. Background Modules pay an
   `await` for an in-process call; that uniformity is the price of one contract.
2. **No function-valued parameters, ever.** Functions do not survive structured clone — they arrive
   as `undefined` and the call silently no-ops. This is exactly how today's `synapse.bus.on()` is
   broken. Subscriptions must be `onX(handler)` where the handler is registered **locally in the
   caller's world** and the transport only pushes serializable events across.
3. **No methods on returned values.** Return plain data. To model a live thing (a running download),
   return an id and expose sibling methods that take it.

## Scopes, not capabilities

The old `Capability = 'net'|'ai'|'cache'|'bus'|'dom'` model is being retired because it cannot
express meaningful consent:

- `bus` is a **god-capability**: `bus.emit(moduleId, payload)` reaches every bundled Module's own
  listener, so granting `bus` grants control of the whole extension. A consent prompt saying
  "allow bus?" is unanswerable.
- `net` and `dom` resolve to no service at all — declaring them is a silent no-op.

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

**Enforced:**

| Scope | Consent line |
|---|---|
| `media.read` | See the media detected on this page |
| `media.download` ×match | Download media from **{domains}** |
| `net.observe` ×match | See requests this page sends to **{domains}** *(URLs may carry tokens)* |
| `net.mock` ×match | Block/modify requests to **{domains}** |
| `storage.rw` | Store this script's own data *(namespaced — cannot read other scripts')* |
| `ui.render` | Show UI on the page |
| `ai.ask` | Send data to an AI model |

**Disclosed** *(in the floating container only — Enforced in a sandboxed-iframe container):*
`page.dom` (read/modify page content), `page.fetch` (make its own network calls, subject to the
page's CORS).

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
primitive**, because the permission records themselves live in that store. This is a live hole in
the current code, not a hypothetical (docs/ROADMAP.md Open Points): `cache.set('synapse:grants', …)`
lets a script grant itself everything. Any storage scope must resolve keys to
`script:<moduleId>:<userKey>` inside the service, with no way for caller-supplied input to escape
the prefix. **Never expose a raw key-value store across a permission boundary.**

### Grant lifecycle

- **Grants reset when a script's source changes.** Store a hash of the source alongside the grant;
  a mismatch clears it and re-prompts (this is what Tampermonkey does on script update). Today this
  holds only by accident — every `uploadModule` mints a fresh uuid — so it will break the moment a
  real "update script" path exists.
- **Bundled modules auto-grant their declared needs** (`chrome-module-registry.ts`) — that's correct
  for first-party code. **Uploaded modules must always default to `[]`.** Keep those two paths
  separate; never let the auto-grant branch reach an uploaded module.

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

1. Interface + scope in `src/kernel/` (pure types).
2. In-process implementation in the owning `features/<name>/`.
3. RPC route + **scope check** in `module-registry/rpc-handler.ts`.
4. Expose on the shim (`user-script-shim.ts`) and on the dom-Module builder (`rpc-client.ts`) — a
   method missing from one transport is a contract break, not a gap.
5. Consent copy for the new scope in the grant UI.
6. `docs/types/synapse-userscript.d.ts` — generate/extend from the same interface so it can't drift.
7. `docs/user-scripts.md` — an example that actually runs.

Steps 4–7 are not optional polish. A method reachable from one context but not another, or absent
from the `.d.ts`, is how a public API rots.

## Never

- **Never expose `bus` to user scripts.** It defeats scoping entirely.
- **Never put the facade on MAIN-world `window`.** Page JS would gain the same access, and
  `moduleId` becomes unforgeable-by-nobody — `sender` identifies a frame, not a script.
- **Never trust `needs`/scopes self-declared by an uploaded script** as authorization. It's a
  *request*; the grant record in `chrome.storage` is the authority.
- **Never let an uploaded script's own `__synapseModule.id` become a routing key** — the extension
  assigns the canonical id at upload time, before the script has ever run.

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
