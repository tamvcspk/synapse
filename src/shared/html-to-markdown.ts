/**
 * Global SDK (docs/design.md §9): pure DOM traversal, no chrome.*, no I/O, no global reads
 * (document/window) of its own — the caller passes the root Node and a baseUrl explicitly, so
 * this survives being imported into a MAIN-world payload or any other restrictive execution
 * context. Mechanism only: it has no opinion on *which* node is "the content" — that's
 * ReaderDistiller's job (policy, owned by the reader-mode-converter Module).
 */

export interface HtmlToMarkdownOptions {
  /** Resolves relative href/src attributes to absolute URLs via `new URL(value, baseUrl)`. */
  baseUrl: string;
}

const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'SECTION',
  'ARTICLE',
  'HEADER',
  'FOOTER',
  'MAIN',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'PRE',
  'FIGURE',
  'FIGCAPTION',
  'TABLE',
  'TR',
]);

const HEADING_LEVEL: Record<string, number> = {
  H1: 1,
  H2: 2,
  H3: 3,
  H4: 4,
  H5: 5,
  H6: 6,
};

/** Ground rule: a node with no rendered box (offsetWidth <= 0) is treated as hidden and skipped. */
function isHiddenElement(el: Element): boolean {
  return el instanceof HTMLElement && el.offsetWidth <= 0;
}

function resolveUrl(value: string, baseUrl: string): string {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function renderChildren(node: Node, options: HtmlToMarkdownOptions): string {
  let out = '';
  for (const child of Array.from(node.childNodes)) {
    out += renderNode(child, options);
  }
  return out;
}

function renderNode(node: Node, options: HtmlToMarkdownOptions): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return collapseWhitespace(node.textContent ?? '');
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  const el = node as Element;
  if (isHiddenElement(el)) {
    return '';
  }

  const tag = el.tagName;

  const headingLevel = HEADING_LEVEL[tag];
  if (headingLevel) {
    return `\n\n${'#'.repeat(headingLevel)} ${collapseWhitespace(el.textContent ?? '').trim()}\n\n`;
  }

  switch (tag) {
    case 'BR':
      return '\n';
    case 'HR':
      return '\n\n---\n\n';
    case 'SCRIPT':
    case 'STYLE':
    case 'NOSCRIPT':
      return '';
    case 'STRONG':
    case 'B':
      return `**${renderChildren(el, options).trim()}**`;
    case 'EM':
    case 'I':
      return `*${renderChildren(el, options).trim()}*`;
    case 'CODE':
      return `\`${el.textContent ?? ''}\``;
    case 'PRE':
      return `\n\n\`\`\`\n${el.textContent ?? ''}\n\`\`\`\n\n`;
    case 'BLOCKQUOTE': {
      const inner = renderChildren(el, options).trim();
      const quoted = inner
        .split('\n')
        .map((line) => (line.length > 0 ? `> ${line}` : '>'))
        .join('\n');
      return `\n\n${quoted}\n\n`;
    }
    case 'A': {
      const href = el.getAttribute('href');
      const label = renderChildren(el, options).trim();
      return href ? `[${label}](${resolveUrl(href, options.baseUrl)})` : label;
    }
    case 'IMG': {
      const src = el.getAttribute('src');
      const alt = el.getAttribute('alt') ?? '';
      return src ? `![${alt}](${resolveUrl(src, options.baseUrl)})` : '';
    }
    case 'LI':
      return `\n- ${renderChildren(el, options).trim()}`;
    case 'UL':
    case 'OL':
      return `\n\n${renderChildren(el, options).trim()}\n\n`;
    default: {
      const inner = renderChildren(el, options);
      return BLOCK_TAGS.has(tag) ? `\n\n${inner.trim()}\n\n` : inner;
    }
  }
}

/** Converts a DOM subtree into Markdown text. Purely a rendering mechanism — the caller decides
 * which root node represents "the content" (see ReaderDistiller). */
export function htmlToMarkdown(root: Node, options: HtmlToMarkdownOptions): string {
  return renderNode(root, options)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
