import TurndownService from 'turndown';

/**
 * Global SDK (docs/design.md §9): no `chrome.*`, no I/O, no global reads (document/window) of its
 * own during actual conversion — the caller passes the root Node and a baseUrl explicitly, so this
 * survives being imported into a MAIN-world payload or any other restrictive execution context.
 * Mechanism only: it has no opinion on *which* node is "the content" — that's the caller's job
 * (e.g. reader-mode-converter.module.ts's Readability-based `clean` step).
 *
 * Wraps Turndown (mixmark-io/turndown) rather than hand-rolled tag-by-tag rendering — battle-tested
 * CommonMark conversion instead of one file re-deriving it. Turndown's `RootNode` clones whatever
 * Node it's given (`input.cloneNode(true)`) instead of parsing an HTML string through the DOM, as
 * long as a Node — never a string — is what reaches `.turndown()`, which is what `htmlToMarkdown`
 * always does; the "no document/window reads of its own" guarantee holds for that path. (Turndown
 * does probe `window.DOMParser` once at import time to pick its string-parsing strategy — inert and
 * guarded, since that strategy is only ever invoked for a string input, which never happens here.)
 */

export interface HtmlToMarkdownOptions {
  /** Resolves relative href/src attributes to absolute URLs via `new URL(value, baseUrl)` —
   * Turndown leaves them exactly as authored, so this file still owns that resolution. */
  baseUrl: string;
  /** Optional hook: given an `<img>`'s resolved absolute URL, returns the URL/path to actually
   * emit in the Markdown — defaults to the absolute URL unchanged. Generic mechanism (no opinion
   * on *why* a URL might be rewritten, docs/design.md §9) — the policy (e.g. pointing at a
   * locally-fetched copy instead of the remote original) belongs to the caller, see
   * reader-mode-converter.module.ts. */
  resolveImageUrl?: (absoluteUrl: string) => string;
}

/** Ground rule: a node explicitly marked hidden is removed entirely (not just visually ignored).
 * Attribute/inline-style based rather than `offsetWidth`-based — the root passed in isn't
 * guaranteed to be attached to a live, rendered document (e.g. reader-mode-converter.module.ts
 * feeds this a Readability-processed clone, which never has real layout), so a layout-dependent
 * check would misfire as "everything is hidden" there. */
function isHiddenElement(el: HTMLElement): boolean {
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
  return el.style.display === 'none' || el.style.visibility === 'hidden';
}

function resolveUrl(value: string, baseUrl: string): string {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

/** Converts a DOM subtree into Markdown text via Turndown. The caller decides which root node
 * represents "the content" — this function has no opinion on that. */
export function htmlToMarkdown(root: Node, options: HtmlToMarkdownOptions): string {
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    hr: '---',
  });

  turndownService.remove(['script', 'style', 'noscript']);
  turndownService.remove((node) => isHiddenElement(node));

  // Turndown's built-in image/link rules use `src`/`href` exactly as authored — these two
  // override them to resolve against `baseUrl` first, and route images through the
  // `resolveImageUrl` hook. `addRule` un-shifts onto the front of Turndown's rule list, so these
  // are matched before the built-in ones of the same tag.
  turndownService.addRule('image-absolute-url', {
    filter: 'img',
    replacement: (_content, node) => {
      const el = node as HTMLImageElement;
      const src = el.getAttribute('src');
      if (!src) return '';
      const alt = el.getAttribute('alt') ?? '';
      const absolute = resolveUrl(src, options.baseUrl);
      return `![${alt}](${options.resolveImageUrl?.(absolute) ?? absolute})`;
    },
  });

  turndownService.addRule('link-absolute-url', {
    filter: 'a',
    replacement: (content, node) => {
      const el = node as HTMLAnchorElement;
      const href = el.getAttribute('href');
      return href ? `[${content}](${resolveUrl(href, options.baseUrl)})` : content;
    },
  });

  return turndownService.turndown(root as unknown as HTMLElement).trim();
}
