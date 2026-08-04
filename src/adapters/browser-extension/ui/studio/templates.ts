/**
 * Builtin-Clone templates (docs/ROADMAP.md §12.4) — small, self-contained `.js` files bundled at
 * build time, one per builtin that declares a `templateId` (see `kernel/module.ts`). Filename
 * (minus `.js`) IS the `templateId` — a 1:1 mapping, no separate manifest to keep in sync.
 *
 * `query: '?raw', import: 'default'` (not the deprecated `{ as: 'raw' }`) — same convention
 * `mock-files.background.ts` already uses for a different query type.
 */
const globbed = import.meta.glob<string>('./templates/*.js', { eager: true, query: '?raw', import: 'default' });

export const TEMPLATES: Record<string, string> = Object.fromEntries(
  Object.entries(globbed).map(([path, source]) => [path.replace(/^.*\//, '').replace(/\.js$/, ''), source]),
);
