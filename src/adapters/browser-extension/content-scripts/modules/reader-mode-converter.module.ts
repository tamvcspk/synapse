import type { Module } from '../../../../kernel/module';
import { htmlToMarkdown } from '../../../../shared/html-to-markdown';

/**
 * ReaderDistiller (docs/ROADMAP.md #1): policy, not mechanism — decides which DOM node counts as
 * "the content" via a text-density heuristic. Colocated with the Module (not src/shared/) because
 * this judgment call is specific to how reader-mode-converter reads a page, not a generic,
 * domain-agnostic hook (docs/design.md §9).
 */
const CANDIDATE_SELECTOR = 'article, main, [role="main"], div, section';
const MIN_CONTENT_LENGTH = 140;

function isVisible(el: Element): boolean {
  return el instanceof HTMLElement && el.offsetWidth > 0;
}

function textLength(el: Element): number {
  return (el.textContent ?? '').trim().length;
}

function linkTextLength(el: Element): number {
  return Array.from(el.querySelectorAll('a')).reduce((sum, a) => sum + (a.textContent?.trim().length ?? 0), 0);
}

/** Scores each visible block candidate by "real text" density (total length minus link-text
 * length, since nav/sidebar noise tends to be mostly links) and returns the best match, falling
 * back to document.body when nothing clears MIN_CONTENT_LENGTH. */
function distillContentNode(doc: Document): Element {
  let best: Element = doc.body;
  let bestScore = 0;

  for (const candidate of Array.from(doc.querySelectorAll(CANDIDATE_SELECTOR))) {
    if (!isVisible(candidate)) continue;

    const total = textLength(candidate);
    if (total < MIN_CONTENT_LENGTH) continue;

    const density = (total - linkTextLength(candidate)) / total;
    const score = total * density;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

export interface ReaderModeResult {
  title: string;
  markdown: string;
}

/** Converts the current page's main content into Markdown: ReaderDistiller picks the content
 * node, HtmlToMarkdownConverter (Global SDK, src/shared/) renders it, resolving relative URLs
 * against document.baseURI. */
export const ReaderModeConverterModule: Module<void, ReaderModeResult> = {
  id: 'reader-mode-converter',
  needs: ['dom'],
  uiSchema: { kind: 'action', actionLabel: 'Convert to Markdown' },
  async run() {
    const contentNode = distillContentNode(document);
    const markdown = htmlToMarkdown(contentNode, { baseUrl: document.baseURI });
    return { title: document.title, markdown };
  },
};
