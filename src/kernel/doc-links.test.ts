import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards documentation against the single most common way it rots: naming a file or directory that
 * has been moved, renamed, or deleted.
 *
 * This is not hypothetical. An audit on 2026-08-06 found four skills still routing work to
 * `src/modules/` and `content-scripts/modules/` — directories deleted when the `features/` axis
 * landed — plus two citing `utils/download-engine.ts` and `utils/floating-widget.ts`, both long
 * gone. `module-scaffold` was, as a result, generating Modules into a folder no glob watched: dead
 * code on arrival, with nothing failing to say so. Every one of those would have been caught here.
 *
 * Lives in `src/` because that is what `vitest.config.ts` collects; it has no production
 * counterpart and imports nothing from the Kernel.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** Directories never worth walking. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.vite']);

/**
 * Paths that are mentioned ON PURPOSE while not existing — always as "this is gone, don't look for
 * it". Keep this list short; an entry here is a claim that the mention is deliberate, so add a
 * reason. If it grows past a handful, the docs are describing history in the wrong file.
 */
const INTENTIONALLY_ABSENT = new Map<string, string>([
  ['src/modules/', 'module-scaffold states the folder was removed'],
  ['content-scripts/modules/', 'module-scaffold states the folder was removed'],
  ['utils/floating-widget.ts', 'in-page-ui-engine states it is gone and any reference is stale'],
  ['floating-widget.ts', 'same, mentioned unqualified in prose'],
  ['utils/download-engine.ts', 'CHANGELOG records it as split apart in Phase 1'],
  ['kernel/environment-guard.ts', 'design.md §8 records it as deleted with the Environment Guard'],
  ['src/kernel/environment-guard.ts', 'same, fully qualified'],
  ['public/kb/', 'doc-sync names a hypothetical location for runtime-readable KB assets'],
  ['esm/vs/', "LESSONS.md quotes Monaco's exports-map subpath, which lives in node_modules"],
  ['esm/vs/index.js', 'same'],
  ['esm/vs/esm/vs/editor/editor.worker.js', 'same — this is the WRONG doubled path, quoted as the bug'],
]);

/** npm package names — a doc citing `monaco-editor/esm/...` means node_modules, not our tree. */
const PACKAGE_NAMES: string[] = (() => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
})();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else out.push(relative(repoRoot, abs).split('\\').join('/'));
  }
  return out;
}

const allFiles = walk(repoRoot);
const allFileSet = new Set(allFiles);
const allDirs = new Set(allFiles.map((f) => dirname(f)).flatMap((d) => {
  const parts = d.split('/');
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}));

/** Docs whose path references are checked. */
function docFiles(): string[] {
  return allFiles.filter(
    (f) =>
      (f.startsWith('.claude/skills/') && f.endsWith('.md')) ||
      (f.startsWith('docs/') && f.endsWith('.md') && !f.startsWith('docs/types/')) ||
      f === 'CLAUDE.md' ||
      f === 'README.md',
  );
}

const CODE_EXTENSIONS = /\.(ts|tsx|js|cjs|mjs|json|md|css|html)$/;

/** Does this string resolve to something real, either from the repo root or as a path suffix? */
function pathExists(candidate: string): boolean {
  const clean = candidate.replace(/\/$/, '');
  if (allFileSet.has(clean) || allDirs.has(clean)) return true;
  // Docs often abbreviate (`utils/ui-compositor.ts` for the full adapter path). Accept a match on a
  // full path segment boundary, so `store.ts` alone can never satisfy `media/store.ts`.
  const suffix = `/${clean}`;
  for (const file of allFileSet) if (file.endsWith(suffix)) return true;
  for (const dir of allDirs) if (dir.endsWith(suffix)) return true;
  return false;
}

function isCheckable(candidate: string): boolean {
  // Placeholders and glob/brace notation describe a shape, not a file.
  if (/[*<>{}$]/.test(candidate)) return false;
  // URL schemes (`chrome://extensions/`, `https://…`) and absolute URL paths (`/ads/`).
  if (candidate.includes('://') || candidate.startsWith('/') || candidate.startsWith('#')) return false;
  // Build output is gitignored and absent on a clean checkout.
  if (candidate === 'dist' || candidate.startsWith('dist/')) return false;
  // Anything inside a dependency lives in node_modules, which this test does not walk.
  const firstSegment = candidate.split('/')[0] ?? '';
  if (firstSegment.startsWith('@') || PACKAGE_NAMES.includes(firstSegment)) return false;
  // A bare directory name with no interior slash (`images/`, `kb/`) is prose, not a path reference.
  if (!candidate.replace(/\/$/, '').includes('/')) return false;
  if (INTENTIONALLY_ABSENT.has(candidate)) return false;
  return true;
}

/** Backticked path-like strings: `src/kernel/scopes.ts`, `features/media/`, `utils/opfs-store.ts`. */
function backtickedPaths(text: string): string[] {
  const found: string[] = [];
  for (const [, inner] of text.matchAll(/`([^`\n]+)`/g)) {
    if (inner === undefined) continue;
    const value = inner.trim();
    if (!value.includes('/')) continue;
    if (/\s/.test(value)) continue;
    if (!CODE_EXTENSIONS.test(value) && !value.endsWith('/')) continue;
    found.push(value);
  }
  return found;
}

/** Markdown link targets, resolved relative to the file containing them. */
function markdownLinkTargets(text: string, fromFile: string): { raw: string; resolved: string }[] {
  const found: { raw: string; resolved: string }[] = [];
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (target === undefined) continue;
    if (target.startsWith('http') || target.startsWith('#') || target.startsWith('mailto:')) continue;
    const withoutAnchor = target.split('#')[0];
    if (!withoutAnchor) continue;
    const resolved = relative(repoRoot, resolve(repoRoot, dirname(fromFile), withoutAnchor))
      .split('\\')
      .join('/');
    found.push({ raw: target, resolved });
  }
  return found;
}

describe('documentation path references', () => {
  const files = docFiles();

  it('scans a meaningful set of docs', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain('CLAUDE.md');
  });

  it.each(files)('%s references only files that exist', (file) => {
    const text = readFileSync(join(repoRoot, file), 'utf8');

    const broken: string[] = [];

    for (const candidate of backtickedPaths(text)) {
      if (!isCheckable(candidate)) continue;
      if (!pathExists(candidate)) broken.push(candidate);
    }

    for (const { raw, resolved } of markdownLinkTargets(text, file)) {
      if (!isCheckable(raw)) continue;
      if (INTENTIONALLY_ABSENT.has(resolved)) continue;
      if (!allFileSet.has(resolved) && !allDirs.has(resolved)) broken.push(`${raw} → ${resolved}`);
    }

    expect([...new Set(broken)]).toEqual([]);
  });

  it('keeps the intentionally-absent allowlist honest', () => {
    // An entry that now exists is no longer "intentionally absent" — drop it, or the allowlist
    // starts hiding real breakage.
    const nowReal = [...INTENTIONALLY_ABSENT.keys()].filter((p) => pathExists(p));
    expect(nowReal, 'these exist again — remove them from INTENTIONALLY_ABSENT').toEqual([]);
  });
});
