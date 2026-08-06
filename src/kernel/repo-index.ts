/**
 * Generator for `docs/INDEX.md` — the codebase map an agent reads BEFORE grepping, so it knows
 * which directory to open instead of searching the whole tree.
 *
 * Same discipline as `userscript-dts.ts` / `ai-context-md.ts`: this file is a PURE builder (no
 * `fs`, no `chrome.*`), and `repo-index.test.ts` does the filesystem walk and snapshots the output
 * to `docs/INDEX.md`. That is what makes the map un-driftable — a directory added, removed, or
 * renamed changes the generated text and the snapshot test goes red until someone updates it.
 *
 * Deliberately NOT stamped with a generation date: a date would churn the snapshot on days with no
 * real change (the lesson `ai-context-md.test.ts` already had to learn with `generatedAt`).
 */

/** One source directory, as discovered on disk. Everything here is derived, never hand-written. */
export interface RepoIndexEntry {
  /** Repo-relative POSIX path, e.g. `src/adapters/browser-extension/features/media`. */
  path: string;
  /** Count of `.ts` files directly in this directory, excluding `*.test.ts`. */
  fileCount: number;
  /** Count of co-located `*.test.ts` files directly in this directory. */
  testCount: number;
  /**
   * Execution contexts actually present, derived from the filename suffix convention
   * (docs/design.md §11). Empty means every file here is context-neutral.
   */
  contexts: string[];
}

/** The hand-written half: what a directory is FOR. A machine cannot infer this. */
export interface RepoAreaDescription {
  /** One line, no trailing period. What lives here and why. */
  role: string;
  /** Skill or doc that governs changes here. Omit if none applies. */
  owner?: string;
}

export interface BuildRepoIndexInput {
  entries: RepoIndexEntry[];
  descriptions: Record<string, RepoAreaDescription>;
}

const SUFFIX_LABELS: Record<string, string> = {
  '.background.ts': 'background',
  '.content.ts': 'content',
  '.page.ts': 'MAIN world',
  '.offscreen.ts': 'offscreen',
  '.module.ts': 'Module',
};

/** Derive the context labels for a directory from the filenames it contains. */
export function contextsForFiles(fileNames: string[]): string[] {
  const found = new Set<string>();
  for (const name of fileNames) {
    for (const [suffix, label] of Object.entries(SUFFIX_LABELS)) {
      if (name.endsWith(suffix)) found.add(label);
    }
  }
  return [...found].sort();
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

/**
 * An entry with no hand-written description renders as UNDESCRIBED rather than being skipped.
 * Silently omitting it would let a new directory join the repo without ever entering the map —
 * exactly the drift this file exists to prevent. A red snapshot is the point.
 */
const UNDESCRIBED = '⚠️ UNDESCRIBED — add an entry to `AREA_DESCRIPTIONS` in `repo-index.test.ts`';

export function buildRepoIndex({ entries, descriptions }: BuildRepoIndexInput): string {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));

  const rows = sorted.map((entry) => {
    const description = descriptions[entry.path];
    const role = description ? escapeCell(description.role) : UNDESCRIBED;
    const owner = description?.owner ? `\`${description.owner}\`` : '—';
    const contexts = entry.contexts.length > 0 ? entry.contexts.join(', ') : '—';
    const tests = entry.testCount > 0 ? String(entry.testCount) : '—';
    return `| \`${entry.path}\` | ${entry.fileCount} | ${tests} | ${contexts} | ${role} | ${owner} |`;
  });

  const totalFiles = sorted.reduce((sum, e) => sum + e.fileCount, 0);
  const totalTests = sorted.reduce((sum, e) => sum + e.testCount, 0);

  return `# Codebase Index

**Generated — do not edit by hand.** Regenerate with \`npm test -- -u\` after adding, removing, or
renaming a source directory. The structure columns come from the filesystem; the Role column comes
from \`AREA_DESCRIPTIONS\` in [\`src/kernel/repo-index.test.ts\`](../src/kernel/repo-index.test.ts).

Read this **before** grepping — it tells you which directory to open. For what the domain nouns
*mean*, see [GLOSSARY.md](GLOSSARY.md). For a feature's business rules, read the \`.domain.md\` in
that feature's own folder.

${sorted.length} source directories · ${totalFiles} source files · ${totalTests} co-located test files.

## The three-layer rule

| Layer | Path | May import | Enforced by |
|---|---|---|---|
| Core | \`src/kernel/\` | \`src/shared/\` only | no \`chrome.*\`, no DOM, no I/O |
| Global SDK | \`src/shared/\` | nothing outside itself | must survive a MAIN-world import |
| Adapter | \`src/adapters/browser-extension/\` | anything | the only Adapter that will ever exist |

## Execution context suffixes

A filename suffix declares which context a file runs in — and it is also what the auto-discovery
globs match, so it is load-bearing, not decoration.

| Suffix | Runs in | \`chrome.*\` available |
|---|---|---|
| \`*.background.ts\` | service worker | all |
| \`*.content.ts\` | content script (ISOLATED) | messaging + storage |
| \`*.module.ts\` | content script, auto-registered as a Module | via \`ctx.api\` |
| \`*.page.ts\` | MAIN world of the real page | **none** |
| \`*.offscreen.ts\` | Offscreen Document | **only \`chrome.runtime\`** |
| *(no suffix)* | more than one context | varies — check callers |

## Map

| Directory | Files | Tests | Contexts | Role | Owner |
|---|---|---|---|---|---|
${rows.join('\n')}
`;
}
