import van from 'vanjs-core';
import '@picocss/pico/css/pico.min.css';
import './help.css';
import pkg from '../../../../../package.json';
import userScriptsGuide from '../../../../../docs/user-scripts.md?raw';
import typeReference from '../../../../../docs/types/synapse-userscript.d.ts?raw';
import { buildAiContextMd } from '../../../../kernel/ai-context-md';
import { icon, ICONS } from '../icon';

/**
 * Help page (docs/ROADMAP.md §11.6 item 9, output 1 of 3) — a standalone Tab (opened via
 * `chrome.tabs.create`, same convention as Dashboard/Studio/Review) for the "user mostly vibe-codes"
 * audience: documentation as a feature, not an appendix.
 *
 * Content is `docs/user-scripts.md` + `docs/types/synapse-userscript.d.ts`, both pulled in verbatim
 * via Vite's `?raw` suffix (same trick `ui/studio/main.ts` already uses for the `.d.ts` file) — no
 * markdown-parser dependency, no second renderer of the scope/method catalog to drift from the one
 * `userscript-dts.ts` already generates. The heading scan below only splits on `^#{2,3} ` lines to
 * build a jump-nav; it never touches inline markdown syntax (bold/links/inline code), so headings and
 * code fences render as literal text inside `white-space: pre-wrap` blocks — prose wraps normally,
 * fenced code stays visually distinct even with its backticks showing. A deliberate simplification,
 * not an oversight (docs/ROADMAP.md §11.6: "tránh thêm dependency markdown-parser").
 *
 * The "Download AI context bundle" button computes `synapse-ai-context.md` live, via the exact same
 * `buildAiContextMd` function `ai-context-md.test.ts` snapshots — so the downloaded file can never be
 * staler than the page serving it.
 */

const { div, header, h1, h2, h3, nav, ul, li, a, section, pre, p, button, span } = van.tags;

interface GuideSection {
  slug: string;
  level: 2 | 3;
  title: string;
  body: string;
}

/** Splits `docs/user-scripts.md` on its own `##`/`###` headings — see the file banner above for why
 * this is a line-oriented structural split, not a markdown parser. */
function splitGuide(markdown: string): GuideSection[] {
  const lines = markdown.split('\n');
  const headingIndices: { index: number; level: 2 | 3; title: string }[] = [];
  lines.forEach((line, index) => {
    const match = /^(#{2,3})\s+(.*)$/.exec(line);
    if (match) headingIndices.push({ index, level: match[1]!.length as 2 | 3, title: match[2]!.trim() });
  });

  const slugCounts = new Map<string, number>();
  const slugify = (title: string): string => {
    const base = title
      .toLowerCase()
      .replace(/`/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const seen = slugCounts.get(base) ?? 0;
    slugCounts.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen}`;
  };

  return headingIndices.map((h, i) => {
    const nextIndex = headingIndices[i + 1]?.index ?? lines.length;
    const body = lines.slice(h.index + 1, nextIndex).join('\n').trim();
    return { slug: slugify(h.title), level: h.level, title: h.title, body };
  });
}

function downloadAiContextBundle(): void {
  const content = buildAiContextMd({
    version: pkg.version,
    generatedAt: new Date().toISOString().slice(0, 10),
    userScriptsGuide,
    typeReference,
  });
  const blobUrl = URL.createObjectURL(new Blob([content], { type: 'text/markdown' }));
  chrome.downloads.download({ url: blobUrl, filename: 'synapse-ai-context.md' }).finally(() => {
    URL.revokeObjectURL(blobUrl);
  });
}

function render(): void {
  const root = document.getElementById('root')!;
  const sections = splitGuide(userScriptsGuide);

  van.add(
    root,
    header(
      { class: 'help-header' },
      div(h1('Synapse — Help'), span({ class: 'version-badge' }, `v${pkg.version}`)),
      button(
        { onclick: downloadAiContextBundle, title: 'Download a flat, self-contained doc for pasting into an AI assistant' },
        icon(ICONS.download),
        ' Download AI context bundle',
      ),
    ),
    div(
      { class: 'help-layout' },
      nav(
        { class: 'help-nav' },
        ul(
          ...sections.map((s) =>
            li({ class: s.level === 3 ? 'nav-sub' : '' }, a({ href: `#${s.slug}` }, s.title)),
          ),
          li({ class: 'nav-sub' }, a({ href: '#api-reference' }, 'Full API reference')),
        ),
      ),
      div(
        { class: 'help-content' },
        ...sections.map((s) =>
          section(
            { id: s.slug },
            s.level === 2 ? h2(s.title) : h3(s.title),
            pre({ class: 'guide-text' }, s.body),
          ),
        ),
        section(
          { id: 'api-reference' },
          h2('Full API reference'),
          p(
            { class: 'reference-note' },
            'Generated from the extension’s own source (', span({ class: 'mono' }, 'docs/types/synapse-userscript.d.ts'), ') — reference it directly in your editor for autocomplete.',
          ),
          pre({ class: 'guide-text mono' }, typeReference),
        ),
      ),
    ),
  );
}

render();
