---
name: doc-sync
description: Fetch, chunk, and save the official documentation of a library/framework version into a local knowledge base under kb/. Use when the user asks to build, sync, or refresh a knowledge base for a library (e.g. "tạo KB cho Angular 18", "sync docs for React 19", "refresh KB for X"). This is a deterministic Synapse Module (no AI, no Bus) — it just fetches and organizes text.
---

# Doc Sync

Build/refresh a local knowledge base of a library's official documentation, so it can be used as
context for tools like GitHub Copilot or as input to other Synapse Modules.

## When invoked

You need three things; ask only for what's missing:
1. **Library name** (e.g. `angular`)
2. **Version** (e.g. `18`) — if the user says "latest", resolve the current stable version first.
3. **Doc source** — if the user didn't give a URL, find the official docs entry point for that
   library+version yourself (WebSearch, then confirm with the user before crawling if ambiguous).

## Steps

1. **Resolve scope.** Identify the doc site's structure (usually a sidebar/TOC page listing all
   sub-pages). Don't guess-crawl the whole domain — stay within the doc section for that version.
2. **Fetch.** Use WebFetch on each relevant page. Respect reasonable limits — if the doc set is
   very large (100+ pages), ask the user to confirm scope (e.g. "just Core Guide" vs "everything
   including API reference") before fetching all of it.
3. **Strip boilerplate.** Drop nav bars, footers, ads, "edit this page" links — keep only the
   substantive content (prose, code samples, tables).
4. **Chunk.** Split each page by heading (H1/H2, then H3 if a section is still large). Each chunk
   should be self-contained enough to be useful out of context — carry the page title and heading
   path (e.g. `Forms > Reactive Forms > Validators`) into the chunk itself.
5. **Write output** under `kb/<library>/<version>/`:
   - One markdown file per chunk, named after its heading path (kebab-case).
   - An `index.json` at the root of that folder listing: `{ file, title, headingPath, sourceUrl,
     fetchedAt }` for every chunk — this is what makes later re-sync and staleness checks
     possible.
6. **Report** a short summary: how many pages fetched, how many chunks written, where.

## Re-sync behavior

If `kb/<library>/<version>/index.json` already exists:
- Compare source URLs — only re-fetch pages that are new or whose content changed.
- Never silently delete existing chunks for pages that disappeared from the source without
  telling the user first.

## Auto-invocation from other skills

Other skills that produce a code plan (`module-scaffold`, `ts-standards`, `kernel-bootstrap`) check
against this section before writing code that leans on a specific external library/framework/API
— they don't duplicate this logic, they just link here. Use this checklist whenever *you* (acting
under one of those skills) are about to implement against a named third-party dependency:

1. **Is a KB actually warranted?** Only for a *specific* external library/framework/SDK/API whose
   correct usage is version-sensitive (e.g. "Stripe SDK", "Notion API", "Angular 18") — not for
   platform primitives already covered by `ts-standards` (`chrome.*`, `fetch`, DOM, `zod`), and not
   for a library used in one trivial, stable call (e.g. one `lodash` helper). When in doubt, skip —
   this is a cost/benefit call, not a default-on step.
2. **Check `kb/<library>/<version>/index.json`.** If it exists and covers the version in play,
   nothing to do — proceed with the code plan using that KB as context.
3. **If missing (or the user is targeting a version it doesn't cover):** don't silently crawl the
   web mid-plan. Surface it in one line — e.g. "No local KB for Stripe v14 yet — build one before I
   scaffold this module? (~2 min)" — and only run the steps above once the user confirms. This
   preserves the "confirm before crawling if ambiguous" rule above even when the trigger is another
   skill instead of a direct user request.
4. **If the user declines or the task is exploratory/low-stakes:** proceed without a KB, but note in
   your final report that the implementation leaned on training-data knowledge of `<library>`
   rather than a synced source, so the user can sanity-check version drift.

## Notes

- This produces static files, not a running Module. If the project's Kernel exists
  (see the `kernel-bootstrap` skill) and the user wants this wired in as a Synapse Module, wrap the
  same fetch/chunk logic in a `Module` with `needs: ['net']` per `docs/design.md` — but don't
  require the Kernel to exist just to run a sync. Synapse itself is a browser extension (no Node
  runtime), but this skill runs via your own WebFetch/Write tools, not inside the extension, so it
  works regardless.
- If the KB is meant to be read *by* the extension at runtime (not just by an external tool like
  Copilot), it must be bundled as a static asset (e.g. under `public/kb/` or wherever the build
  config exposes `web_accessible_resources`), not left in an arbitrary top-level folder — an
  extension can't read arbitrary local filesystem paths at runtime.
- Keep this deterministic: no summarizing, rewriting, or "improving" the source text. The
  knowledge base should mirror the source faithfully — that's the point of building it.
