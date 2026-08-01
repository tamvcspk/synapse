import { Readability } from '@mozilla/readability';
import type { Module, ModuleContext } from '../../../../kernel/module';
import { createCompositeModule } from '../../../../kernel/composite-module';
import { htmlToMarkdown } from '../../../../shared/html-to-markdown';
import { slugify } from '../../../../shared/slugify';
import { bytesToBase64 } from '../../utils/blob-store';

/**
 * Reader Mode Converter (docs/ROADMAP.md #1, rebuilt as a Composite Module for #3): load dom →
 * clean → fetch images → convert to Markdown, each step bypassable independently via the
 * Dashboard's per-step toggle (docs/ROADMAP.md #3's steps-view.ts). Every step reads/extends the
 * same accumulating shape, so bypassing a step degrades gracefully by construction — the next step
 * just sees whatever the previous one already put there, no special-case handling needed.
 *
 * "Clean" uses Mozilla's `@mozilla/readability` (the library behind Firefox's Reader View) instead
 * of a hand-rolled heuristic — battle-tested against real-world page markup rather than one
 * text-density formula. Readability **mutates** the document it's given, so `load-dom` hands it a
 * detached clone (its own documented usage pattern) rather than the live page — safe here because,
 * unlike a hand-rolled distiller keyed on `el.offsetWidth`, Readability's own visibility checks are
 * attribute/inline-style-based (`hidden`, `aria-hidden`, `style.display`), not layout-dependent, and
 * `html-to-markdown.ts`'s hidden-element check was updated to match for the same reason (a detached
 * clone never has real layout to read `offsetWidth` from).
 *
 * Two actions (docs/ROADMAP.md #1's Crawl & Convert Site): the ordinary single-page conversion
 * below (`pageComposite`), and `crawlSite` — discovers every same-origin doc page and runs each one
 * through that *same* pipeline. `LoadDomStep` is what makes that reuse possible: fed an already-built
 * `ReaderPipelineValue` (from a fetched+parsed remote page), it passes it through unchanged instead
 * of cloning the live document.
 */
interface ReaderPipelineValue {
  doc: Document;
  root: Element;
  baseUrl: string;
  title: string;
  images: FetchedImage[];
}

interface FetchedImage {
  originalUrl: string;
  localPath: string;
  mimeType: string;
  base64: string;
}

export interface ReaderModeFile {
  fileName: string;
  mimeType: string;
  base64: string;
}

/** One page's conversion output — `pageComposite`'s own result shape, before it's wrapped (single
 * page) or collected (crawl) into the public `ReaderModeResult` below. Not exported: callers of
 * this Module only ever see the wrapped shape. */
interface PageConversionResult {
  title: string;
  markdown: string;
  files: ReaderModeFile[];
}

export interface ReaderModePage {
  /** Relative file path within the downloaded bundle (docs/ROADMAP.md #1's file-per-page
   * structure) — e.g. `guide/signals.md` for a crawled page, or an editable `<slug>.md` for a
   * single-page conversion. Always ends in `.md`. */
  path: string;
  title: string;
  markdown: string;
}

/** `run()`'s result for both actions (docs/ROADMAP.md #1) — single-page conversion produces one
 * `pages` entry, Crawl & Convert Site produces one per successfully-converted page. Always this
 * one shape so the Review page (`ui/review/`) never has to branch on which action produced it,
 * only on how many pages are in it. */
export interface ReaderModeResult {
  title: string;
  pages: ReaderModePage[];
  files: ReaderModeFile[];
}

const LoadDomStep: Module<ReaderPipelineValue | undefined, ReaderPipelineValue> = {
  id: 'reader-mode-converter/load-dom',
  label: 'Load DOM',
  async run(input) {
    if (input) return input; // crawlSite already built this from a fetched+parsed remote page
    const doc = document.cloneNode(true) as Document;
    return { doc, root: doc.body, baseUrl: document.baseURI, title: document.title, images: [] };
  },
};

const CleanStep: Module<ReaderPipelineValue, ReaderPipelineValue> = {
  id: 'reader-mode-converter/clean',
  label: 'Clean content (Readability)',
  async run(input) {
    // Custom serializer: returns the article's root Element directly instead of Readability's
    // default (an HTML string) — avoids reparsing a string back into a DOM node just to hand it
    // to htmlToMarkdown, which already resolves `<img>`/`<a>` URLs against `baseUrl` itself.
    const reader = new Readability<Element>(input.doc, { serializer: (el) => el as unknown as Element });
    const article = reader.parse();
    if (!article?.content) return input; // not readerable — fall back to the raw cloned <body>
    return { ...input, root: article.content, title: article.title || input.title };
  },
};

// Best-effort safety cap — a pathologically large "image" (e.g. an accidentally-embedded video)
// shouldn't blow up the message payload back to the popup; skipping it just leaves that one image
// as its original remote URL (same graceful-fail treatment as a failed fetch, below).
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Derives a unique `images/<name>` filename from the URL's pathname, falling back to a
 * mime-derived name when the URL has none usable, de-duplicating on collision. */
function uniqueFileName(absoluteUrl: string, mimeType: string, seen: Set<string>): string {
  let base = '';
  try {
    base = decodeURIComponent(new URL(absoluteUrl).pathname.split('/').pop() ?? '');
  } catch {
    // fall through to the mime-derived default below
  }
  if (!base || !/\.[a-z0-9]+$/i.test(base)) {
    const ext = mimeType.split('/')[1]?.split('+')[0] || 'bin';
    base = `image.${ext}`;
  }

  let name = base;
  let n = 2;
  while (seen.has(name)) {
    const dot = base.lastIndexOf('.');
    name = dot === -1 ? `${base}-${n}` : `${base.slice(0, dot)}-${n}${base.slice(dot)}`;
    n++;
  }
  seen.add(name);
  return name;
}

const FetchImagesStep: Module<ReaderPipelineValue, ReaderPipelineValue> = {
  id: 'reader-mode-converter/fetch-images',
  label: 'Fetch images',
  async run(input) {
    const images: FetchedImage[] = [];
    const seenNames = new Set<string>();

    for (const img of Array.from(input.root.querySelectorAll('img'))) {
      const src = img.getAttribute('src');
      if (!src || src.startsWith('data:')) continue; // already self-contained, nothing to fetch

      let absolute: string;
      try {
        absolute = new URL(src, input.baseUrl).toString();
      } catch {
        continue;
      }
      if (images.some((i) => i.originalUrl === absolute)) continue; // dedupe repeated images

      try {
        // Cross-origin fetch from a content script is granted the same host_permissions-based
        // privilege as a background fetch (manifest.config.ts's host_permissions: ['<all_urls>']) —
        // no Bus/background hop needed to stay within this Module's own execution context.
        const res = await fetch(absolute);
        if (!res.ok) continue;
        const buf = await res.arrayBuffer();
        if (buf.byteLength > MAX_IMAGE_BYTES) continue;
        const mimeType = res.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream';
        const localPath = `images/${uniqueFileName(absolute, mimeType, seenNames)}`;
        images.push({ originalUrl: absolute, localPath, mimeType, base64: bytesToBase64(buf) });
      } catch {
        // Graceful fail — leave this one image as its original remote URL rather than aborting.
      }
    }

    return { ...input, images };
  },
};

const ConvertMarkdownStep: Module<ReaderPipelineValue, PageConversionResult> = {
  id: 'reader-mode-converter/convert-markdown',
  label: 'Convert to Markdown',
  async run(input) {
    const localPathByUrl = new Map(input.images.map((i) => [i.originalUrl, i.localPath]));
    const markdown = htmlToMarkdown(input.root, {
      baseUrl: input.baseUrl,
      resolveImageUrl: (absoluteUrl) => localPathByUrl.get(absoluteUrl) ?? absoluteUrl,
    });
    return {
      title: input.title,
      markdown,
      files: input.images.map(({ localPath, mimeType, base64 }) => ({ fileName: localPath, mimeType, base64 })),
    };
  },
};

const pageComposite = createCompositeModule({
  id: 'reader-mode-converter',
  label: 'Reader Mode Converter',
  description:
    'Distills the page into Markdown, fetching images so they can be reviewed and downloaded as a bundle.',
  subModules: [LoadDomStep, CleanStep, FetchImagesStep, ConvertMarkdownStep],
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const NAV_SELECTOR = 'nav, [role="navigation"]';

/** Clicks every collapsed disclosure button under `root`, waiting for the DOM to update and
 * repeating — expanding one item can reveal further collapsed children. Capped at a fixed number
 * of rounds as a guard against a site whose nav never fully settles. */
async function expandAllNavButtons(root: ParentNode): Promise<void> {
  for (let round = 0; round < 20; round++) {
    const collapsed = Array.from(root.querySelectorAll('button[aria-expanded="false"]'));
    if (collapsed.length === 0) return;
    for (const btn of collapsed) (btn as HTMLElement).click();
    await sleep(150);
  }
}

/** Fallback URL discovery (docs/ROADMAP.md #1) when no sitemap is published — auto-expands the
 * current page's nav, then reads every `<a href>` still inside it. */
async function discoverUrlsFromNav(baseUrl: string): Promise<string[]> {
  const navRoots = Array.from(document.querySelectorAll(NAV_SELECTOR));
  for (const navEl of navRoots) await expandAllNavButtons(navEl);

  const urls = new Set<string>();
  for (const navEl of navRoots) {
    for (const a of Array.from(navEl.querySelectorAll('a[href]'))) {
      const href = a.getAttribute('href');
      if (!href) continue;
      try {
        urls.add(new URL(href, baseUrl).toString());
      } catch {
        // not a resolvable URL — skip
      }
    }
  }
  return Array.from(urls);
}

/** Primary URL discovery: a published sitemap is faster, simpler, and doesn't depend on guessing
 * the nav's markup at all. Tries `robots.txt`'s `Sitemap:` directive first (the canonical way a
 * site announces a non-default location), then the conventional `/sitemap.xml` path. Returns
 * `undefined` (not an empty array) when nothing usable was found, so the caller knows to fall back
 * to nav-crawling rather than treating "no sitemap" as "site has zero pages". */
async function discoverUrlsFromSitemap(origin: string): Promise<string[] | undefined> {
  const candidates = [`${origin}/sitemap.xml`];
  try {
    const robotsRes = await fetch(`${origin}/robots.txt`);
    if (robotsRes.ok) {
      const robotsText = await robotsRes.text();
      for (const line of robotsText.split('\n')) {
        const match = /^\s*Sitemap:\s*(\S+)/i.exec(line);
        if (match) candidates.unshift(match[1]!);
      }
    }
  } catch {
    // robots.txt fetch failed — fall back to the default candidate above
  }

  for (const url of candidates) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const xml = await res.text();
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      if (doc.querySelector('parsererror')) continue;
      const locs = Array.from(doc.querySelectorAll('loc'))
        .map((el) => el.textContent?.trim())
        .filter((u): u is string => !!u);
      if (locs.length > 0) return locs;
    } catch {
      // this candidate failed — try the next one
    }
  }
  return undefined;
}

/** Derives a page's file path from its URL, mirroring the site's own structure (docs/ROADMAP.md
 * #1) — e.g. `https://angular.dev/guide/signals` → `guide/signals.md`, site root → `index.md`.
 * Each path segment is slugified independently (not the whole pathname at once) so `/` boundaries
 * survive as folder separators instead of being collapsed away. */
function pathFromUrl(url: string): string {
  let pathname = '/';
  try {
    pathname = new URL(url).pathname;
  } catch {
    // keep the '/' default — falls through to 'index.md' below
  }
  const segments = pathname
    .split('/')
    .filter(Boolean)
    .map((seg) => slugify(decodeURIComponent(seg)));
  return segments.length === 0 ? 'index.md' : `${segments.join('/')}.md`;
}

/** De-duplicates a derived page path (e.g. two URLs that both slugify to the same thing) the same
 * way `uniqueFileName` above de-duplicates image names — numeric suffix before the extension. */
function uniquePagePath(path: string, seen: Set<string>): string {
  let candidate = path;
  let n = 2;
  while (seen.has(candidate)) {
    const dot = path.lastIndexOf('.');
    candidate = dot === -1 ? `${path}-${n}` : `${path.slice(0, dot)}-${n}${path.slice(dot)}`;
    n++;
  }
  seen.add(candidate);
  return candidate;
}

/** Assembles the crawl's final `ReaderModeResult` — one `pages` entry per successfully-converted
 * URL (file path mirrors the site structure), images re-namespaced per page (prefixed with that
 * page's own path, "/" flattened to "-") so same-named images on different pages don't collide
 * once bundled into one zip (Review page's Download ZIP, docs/ROADMAP.md #3). */
function buildCrawlResult(pages: { url: string; result: PageConversionResult }[]): ReaderModeResult {
  const seenPaths = new Set<string>();
  const resultPages: ReaderModePage[] = [];
  const files: ReaderModeFile[] = [];

  for (const { url, result } of pages) {
    const path = uniquePagePath(pathFromUrl(url), seenPaths);
    resultPages.push({ path, title: result.title, markdown: result.markdown });

    const imagePrefix = path.replace(/\.md$/, '').replace(/\//g, '-');
    for (const file of result.files) {
      files.push({ ...file, fileName: `images/${imagePrefix}-${file.fileName.replace(/^images\//, '')}` });
    }
  }

  return { title: location.hostname, pages: resultPages, files };
}

// Bounds worst-case runtime/payload size — a graceful partial result (whatever was found up to
// this many pages) rather than a runaway crawl, same role as MAX_IMAGE_BYTES above.
const MAX_CRAWL_PAGES = 200;
const CRAWL_FETCH_DELAY_MS = 200;

/** Crawl & Convert Site action (docs/ROADMAP.md #1): discovers every same-origin doc page (sitemap
 * first, nav-expand fallback), fetches and converts each one through the same `pageComposite` used
 * for the live page, and combines the results into one bundle.
 *
 * Deliberately `fetch()` + `DOMParser`, not `chrome.tabs` navigation — no background/tab
 * orchestration needed, the whole feature stays inside this one content-script Module. Trade-off:
 * a page needs its content in the raw HTML response (server-rendered/prerendered) to convert
 * meaningfully — a fully client-rendered page (no SSR) just yields thin/empty markdown for that one
 * page, since its JS never runs here, rather than aborting the whole crawl (graceful fail, same
 * style as a single failed image fetch above). */
async function crawlSite(ctx: ModuleContext): Promise<ReaderModeResult> {
  const origin = location.origin;
  const sitemapUrls = await discoverUrlsFromSitemap(origin);
  const discovered = sitemapUrls ?? (await discoverUrlsFromNav(document.baseURI));

  const uniqueUrls = Array.from(
    new Set(
      discovered.filter((u) => {
        try {
          return new URL(u).origin === origin;
        } catch {
          return false;
        }
      }),
    ),
  ).slice(0, MAX_CRAWL_PAGES);

  const pages: { url: string; result: PageConversionResult }[] = [];
  for (let i = 0; i < uniqueUrls.length; i++) {
    const url = uniqueUrls[i]!;
    try {
      const res = await fetch(url);
      if (res.ok) {
        const html = await res.text();
        const parsedDoc = new DOMParser().parseFromString(html, 'text/html');
        const initial: ReaderPipelineValue = {
          doc: parsedDoc,
          root: parsedDoc.body,
          baseUrl: url,
          title: parsedDoc.title,
          images: [],
        };
        const result = (await pageComposite.run(initial, ctx)) as PageConversionResult;
        pages.push({ url, result });
      }
    } catch {
      // graceful fail — skip this page, keep crawling the rest
    }
    void chrome.runtime.sendMessage({ type: 'reader-mode-crawl-progress', done: i + 1, total: uniqueUrls.length }).catch(() => {});
    if (i < uniqueUrls.length - 1) await sleep(CRAWL_FETCH_DELAY_MS);
  }

  return buildCrawlResult(pages);
}

// docs/ROADMAP.md §9.1: no uiSchema — this module isn't triggered from the Popup at all. A
// content-script-injected floating icon (content-scripts/index.ts's showReaderModeIcons, reusing
// utils/ui-compositor.ts the same way network-sniffer's icon does) offers the Convert/Crawl
// choice directly on the page and calls `run()` in-process, since trigger and execution are
// already the same context — no chrome.tabs.sendMessage round trip needed. uiParadigm:
// 'float-widget' just gives it the same "Shows on-page alerts when active" popup tooltip
// network-sniffer already gets (list-view.ts).
export const ReaderModeConverterModule: Module<{ action?: string } | undefined, ReaderModeResult> = {
  ...pageComposite,
  uiParadigm: 'float-widget',
  async run(input, ctx) {
    if (input?.action === 'crawl-site') return crawlSite(ctx);
    const page = (await pageComposite.run(undefined, ctx)) as PageConversionResult;
    return {
      title: page.title,
      pages: [{ path: `${slugify(page.title, 'reader-mode')}.md`, title: page.title, markdown: page.markdown }],
      files: page.files,
    };
  },
};
