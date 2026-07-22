import type { Module } from '../../../../kernel/module';
import { createCompositeModule } from '../../../../kernel/composite-module';
import { htmlToMarkdown } from '../../../../shared/html-to-markdown';
import { bytesToBase64 } from '../../utils/blob-store';

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

/**
 * Reader Mode Converter (docs/ROADMAP.md #1, rebuilt as a Composite Module for #3): load dom →
 * clean → fetch images → convert to Markdown, each step bypassable independently via the
 * Dashboard's per-step toggle (docs/ROADMAP.md #3's steps-view.ts). Every step reads/extends the
 * same accumulating shape, so bypassing a step degrades gracefully by construction — the next step
 * just sees whatever the previous one already put there, no special-case handling needed.
 *
 * Deliberately entirely read-only against the *live* `document` — never cloned, never mutated.
 * `distillContentNode` (and `htmlToMarkdown`'s own hidden-element check) rely on `el.offsetWidth`,
 * which only reflects reality for nodes still attached to the rendered page; cloning the document
 * up front to allow safe mutation would detach everything from layout and silently break every
 * visibility check. "Clean" narrows down which node counts as content — it never strips/removes
 * anything from the page the user is actually looking at.
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

export interface ReaderModeResult {
  title: string;
  markdown: string;
  files: ReaderModeFile[];
}

const LoadDomStep: Module<void, ReaderPipelineValue> = {
  id: 'reader-mode-converter/load-dom',
  label: 'Load DOM',
  needs: ['dom'],
  async run() {
    return { doc: document, root: document.body, baseUrl: document.baseURI, title: document.title, images: [] };
  },
};

const CleanStep: Module<ReaderPipelineValue, ReaderPipelineValue> = {
  id: 'reader-mode-converter/clean',
  label: 'Clean content',
  needs: ['dom'],
  async run(input) {
    return { ...input, root: distillContentNode(input.doc) };
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
  needs: ['dom'],
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

const ConvertMarkdownStep: Module<ReaderPipelineValue, ReaderModeResult> = {
  id: 'reader-mode-converter/convert-markdown',
  label: 'Convert to Markdown',
  needs: ['dom'],
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

export const ReaderModeConverterModule: Module<void, ReaderModeResult> = createCompositeModule({
  id: 'reader-mode-converter',
  description:
    'Distills the page into Markdown, fetching images so they can be reviewed and downloaded as a bundle.',
  subModules: [LoadDomStep, CleanStep, FetchImagesStep, ConvertMarkdownStep],
  uiSchema: { kind: 'action', actionLabel: 'Convert to Markdown', resultView: 'files' },
}) as Module<void, ReaderModeResult>;
