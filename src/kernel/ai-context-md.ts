/**
 * Generator for `docs/synapse-ai-context.md` — the flat, self-contained bundle an AI assistant
 * reads when helping write a Synapse user script (docs/ROADMAP.md §11.6 item 9, output 3 of 3).
 *
 * Assembles from two already-authoritative sources, duplicating neither:
 * - `docs/user-scripts.md` — the human-written concept/authoring guide, embedded verbatim. Its
 *   "Three rules that are not style preferences" / "Failure handling" / "Migrating from `needs`"
 *   sections are exactly the "things that fail silently" ROADMAP.md §11.6 wants placed BEFORE the
 *   formal API reference — true for free from this ordering, since the reference goes last.
 * - `docs/types/synapse-userscript.d.ts` — the generated type reference (`userscript-dts.ts`),
 *   appended verbatim inside a fenced code block. Not re-derived from `SCOPE_CATALOG`/`API_METHODS`
 *   a second time: one renderer of the catalog, never two drifting independently.
 *
 * Both source strings are read by the caller (like `buildUserscriptDts`, this stays a pure function
 * of its inputs) — `ai-context-md.test.ts` reads them from disk for the checked-in snapshot;
 * `ui/help/main.ts` pulls them in via Vite's `?raw` import (same trick `ui/studio/main.ts` already
 * uses for the same `.d.ts` file) so the live "Download" button can never be staler than the page
 * serving it.
 */
export function buildAiContextMd(input: {
  version: string;
  /** Caller-supplied so this stays deterministic for the snapshot test — the live Help page passes
   * `new Date().toISOString().slice(0, 10)`, the test passes a fixed literal. */
  generatedAt: string;
  /** Raw contents of `docs/user-scripts.md`. */
  userScriptsGuide: string;
  /** Raw contents of `docs/types/synapse-userscript.d.ts`. */
  typeReference: string;
}): string {
  const { version, generatedAt, userScriptsGuide, typeReference } = input;

  return `# Synapse User Script API — AI Context Bundle

Synapse v${version}, bundle generated ${generatedAt}. This file is self-contained context for an AI
assistant writing a Synapse user script — no other file or link is needed. If the extension version
you're actually working against differs from the one above, treat this bundle as possibly stale: a
scope or method it doesn't mention may have been added or changed since.

---

${userScriptsGuide.trim()}

---

## Full type reference

Generated straight from the extension's own source (\`kernel/synapse-api.ts\` + \`kernel/scopes.ts\`),
authoritative over anything above if the two ever disagree. Every scope and every \`synapseApi.*\`
method, with the same descriptions the in-extension consent screen shows.

\`\`\`typescript
${typeReference.trim()}
\`\`\`
`;
}
