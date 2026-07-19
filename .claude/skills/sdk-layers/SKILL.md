---
name: sdk-layers
description: Decide where a non-Module utility/helper belongs in Synapse — the 2-Layer SDK convention (Global SDK vs Environment-Specific SDK) from docs/design.md §9. Use when adding a shared helper, matcher, formatter, validator, or infra utility that isn't itself a Module, or when reviewing where existing utility code should live.
---

# 2-Layer SDK (Global vs Environment-Specific)

Synapse splits non-Module utility code into two layers so a file's location always tells you how
portable it is. Full rationale: `docs/design.md` §9. This is a *placement* convention, not a new
runtime concept — it doesn't touch the Kernel, `Module`, or `Capability` contracts.

## The two layers

**Layer 1 — Global SDK: `src/shared/`**
- Pure functions only. No DOM, no `chrome.*`, no I/O, no side effects, no imports from
  `src/adapters/`.
- Importable from `src/kernel/`, `src/modules/`, any `src/adapters/<env>/`, and — the reason this
  layer exists at all — from a MAIN-world page-injection payload (see the `main-world-interceptor`
  skill), which has zero `chrome.*` access and doesn't share a JS heap with the rest of the
  extension.

**Layer 2 — Environment-Specific SDK: `src/adapters/<env>/utils/`**
- Infra helpers that do the "dirty work" for one Adapter: DOM injection/registration, storage
  wiring, messaging bridges, anything touching `chrome.*`/`vscode.*`/Node APIs.
- Never imported by `src/kernel/` or `src/modules/` (the *portable* Modules folder) — same boundary
  rule as everything else in `docs/design.md` §7's project structure. A second Adapter (§8, not
  built yet) would get its own sibling `utils/` and share nothing with `browser-extension/utils/`
  except the `Module`/Service contracts. Freely importable by Modules that live *inside* the
  Adapter itself — `content-scripts/modules/*.module.ts` and `background/modules/<name>/index.ts`
  — since those are already browser-specific and not claiming portability.

## The litmus test — read this before defaulting to "Global"

Don't ask "is this reusable across features?" Ask: **"does this survive being imported into the
most restrictive execution context Synapse has?"** Today that's a MAIN-world payload. If the answer
is no — because it touches `document`/`window` unconditionally, calls `chrome.*`, or does any I/O —
it's Layer 2, no matter how generic-looking the logic is. If yes, it's Layer 1, even if only one
feature uses it right now.

A Global SDK file can still be domain-specific in *subject matter*. `src/shared/http-mock.ts`
models an HTTP mock rule — meaningless outside the browser-extension Adapter's HTTP-mocking feature
— but it's still Layer 1, because it has zero side effects and the MAIN-world interceptor payload
needs to import it directly. "Global" describes the absence of side effects, not the absence of
domain-specificity.

## Mechanism vs policy — the same question at function granularity

The litmus test above decides a *file's* layer. Inside a Layer 2 file, or when deciding whether a
piece of logic belongs in Layer 2 at all vs. inside a Module, ask the narrower question: **would
this logic still make sense if the domain type next to it were swapped for something unrelated?**

- Yes → it's a **mechanism**. Belongs in `utils/`, expressed as a generic function taking a
  hook/callback parameter, with no `import` of any domain type (`MockConfig` or otherwise).
  Example: `utils/main-world/network-interceptor.ts`'s `installNetworkInterceptor(evaluate)` — the
  fetch/XHR patch plumbing doesn't know or care what `evaluate` decides.
- No → it's **policy** (validation rules, matching/routing decisions, what counts as valid state).
  Belongs in `src/shared/` (if it clears the litmus test above) or directly in the Module. Example:
  `src/shared/http-mock.ts`'s `matchMockConfig`/`buildFakeResponseInit` — these only make sense
  because they know what a `MockConfig` is.

A single file that mixes both is a sign to split it: keep the generic mechanism in `utils/`, move
the policy to wherever the Module composes the two (see `main-world-interceptor`'s "composition
root" pattern for a worked example of this split).

## Don't do this

- **Don't create `src/shared/` entries speculatively.** If only one call site needs a helper and
  that call site isn't a restrictive-environment bundle (MAIN-world payload, or a genuinely
  different future Adapter), colocate the helper with the Module/file that needs it instead —
  Progressive Complexity (`docs/design.md` §5) applies to utilities too, not just Modules.
- **Don't put feature-specific domain types in `src/kernel/module.ts`.** That file is the Core's
  generic contract surface (`Module`, `Capability`, Services) — a single feature's data shape (e.g.
  a mock-rule config) belongs in `src/shared/` if it clears the litmus test above, or colocated with
  the feature's Module otherwise. Keeping the Kernel minimalist is itself a stated principle
  (§5 Zero-Cost Opt-in / progressive complexity), and a growing `module.ts` erodes it.
  Kernel/module.ts.
- **Don't let a Layer 2 file leak into Layer 1.** If a "shared" util ends up needing even one
  `chrome.*` call, it's not Global anymore — move it to `src/adapters/<env>/utils/` rather than
  guarding the call with a feature check.

## Quick placement checklist

1. Is it a `Module` (`id`/`needs`/`run()`)? → not this skill, see `module-scaffold`.
2. Does it touch `chrome.*`/DOM/Node APIs, or do any I/O? → `src/adapters/<env>/utils/` — but first
   ask the mechanism-vs-policy question above; if it's actually policy wearing an infra costume,
   it belongs in the Module instead, not in `utils/`.
3. Otherwise: will it be imported into a restrictive-environment bundle (MAIN-world payload today)?
   → `src/shared/`.
4. Otherwise: is it used by more than one Module/file already, not hypothetically? → `src/shared/`
   is fine, but colocating with the single current caller until a second one appears is equally
   valid — don't force it.
