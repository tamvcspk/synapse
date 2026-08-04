/**
 * TEMPLATE — starting point for a page-to-Markdown script (docs/ROADMAP.md §12.4).
 *
 * What this does TODAY, with the API available when this template was written:
 * - Walks `document.body` and converts it to Markdown with the small hand-rolled walker below
 *   (headings, paragraphs, links, images, lists, bold/italic, code) — `page.dom` is Disclosed, no
 *   `ctx.api` call needed just to read the page.
 * - Saves the result under this script's own `storage.rw` namespace and logs it.
 *
 * What it CANNOT do, compared to the builtin "Reader Mode Converter":
 * - No Readability-style "find the real article, strip nav/ads/sidebars" pass — this walks
 *   `document.body` as-is (SKIP_TAGS below is a crude approximation: nav/footer/aside/script/style
 *   only). The builtin runs the Readability library; there is no scope that lets a user script pull
 *   in a third-party library, so this template cannot close that gap, only approximate it.
 * - No image downloading — image URLs are left as absolute remote links, never fetched and bundled
 *   into a reviewable ZIP. There is no `ctx.api` scope today for "fetch this URL as a file" or "zip
 *   these files together".
 * - Markdown coverage is intentionally small (no tables, no nested blockquotes, no fenced code with
 *   language hints) — the builtin uses the Turndown library for full CommonMark support, which has
 *   the same "no way to bundle a third-party library" problem as Readability above.
 *
 * Missing scopes for full parity: none of the above are permission problems — they're missing
 * platform capabilities (a way to run trusted third-party libraries, and a fetch-as-file/zip
 * primitive). Until those exist, this template is the honest ceiling for a plain script here.
 */
__synapseModule = {
  id: 'reader-mode-lite',
  scopes: ['storage.rw'],

  async run(input, ctx) {
    const markdown = htmlToMarkdown(document.body);
    await ctx.api.storage.set('last-markdown', markdown);
    console.log(markdown);
    return { title: document.title, markdown };
  },
};

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'NAV', 'FOOTER', 'ASIDE', 'IFRAME', 'SVG']);

function htmlToMarkdown(root) {
  return walk(root).replace(/\n{3,}/g, '\n\n').trim();
}

function walk(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent.replace(/\s+/g, ' ');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  if (SKIP_TAGS.has(node.tagName)) return '';
  if (node.hidden || node.getAttribute('aria-hidden') === 'true') return '';

  const children = () => Array.from(node.childNodes).map(walk).join('');

  switch (node.tagName) {
    case 'H1':
      return `\n# ${children().trim()}\n\n`;
    case 'H2':
      return `\n## ${children().trim()}\n\n`;
    case 'H3':
      return `\n### ${children().trim()}\n\n`;
    case 'H4':
    case 'H5':
    case 'H6':
      return `\n#### ${children().trim()}\n\n`;
    case 'P':
      return `\n${children().trim()}\n\n`;
    case 'BR':
      return '\n';
    case 'STRONG':
    case 'B':
      return `**${children()}**`;
    case 'EM':
    case 'I':
      return `*${children()}*`;
    case 'CODE':
      return `\`${children()}\``;
    case 'PRE':
      return `\n\`\`\`\n${node.textContent}\n\`\`\`\n\n`;
    case 'A': {
      const href = node.getAttribute('href');
      const text = children().trim();
      return href ? `[${text}](${new URL(href, location.href).toString()})` : text;
    }
    case 'IMG': {
      const src = node.getAttribute('src');
      return src ? `![${node.getAttribute('alt') ?? ''}](${new URL(src, location.href).toString()})` : '';
    }
    case 'LI':
      return `- ${children().trim()}\n`;
    case 'UL':
    case 'OL':
      return `\n${children()}\n`;
    case 'BLOCKQUOTE':
      return `\n> ${children().trim()}\n\n`;
    default:
      return children();
  }
}
