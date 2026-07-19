---
mode: agent
description: Fetch, chunk, and save a library's official docs into a local knowledge base under kb/.
---

Build or refresh a local knowledge base for a library's documentation, for use as context in tools
like Copilot itself.

Ask for whatever is missing: library name, version (resolve "latest" to the current stable
version), and doc source URL (find the official entry point yourself if not given, and confirm
scope before crawling if ambiguous).

Steps:
1. Identify the doc site's structure (sidebar/TOC) — stay within the section for that version,
   don't crawl the whole domain.
2. Fetch each relevant page. If the doc set is large (100+ pages), confirm scope with the user
   first (e.g. "Core Guide only" vs "everything including API reference").
3. Strip boilerplate (nav, footers, "edit this page" links) — keep prose, code samples, tables.
4. Chunk each page by heading (H1/H2, then H3 if a section is still large). Carry the page title
   and heading path into each chunk so it's self-contained out of context.
5. Write output under `kb/<library>/<version>/`: one markdown file per chunk (kebab-case name from
   its heading path), plus an `index.json` listing `{ file, title, headingPath, sourceUrl,
   fetchedAt }` for every chunk.
6. Report how many pages were fetched, how many chunks written, and where.

Re-sync: if `index.json` already exists, only re-fetch pages that are new or changed; never
silently delete chunks for pages that disappeared without telling the user first.

Keep this deterministic — mirror the source faithfully, don't summarize or rewrite it. That's the
point of a knowledge base.

If the result is meant to be read by the extension itself at runtime (not just by an external tool
like Copilot), it must be bundled as a static asset (e.g. `public/kb/`, exposed via
`web_accessible_resources`), not left in an arbitrary folder — see `docs/design.md` §7.
