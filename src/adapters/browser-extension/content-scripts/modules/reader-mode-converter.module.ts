import { Readability } from '@mozilla/readability';
import type { Module } from '../../../../kernel/module';
import { createCompositeModule } from '../../../../kernel/composite-module';
import { htmlToMarkdown } from '../../../../shared/html-to-markdown';
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
    // Cloned once here (not inside `clean`) so bypassing `clean` still gets a valid, if
    // unprocessed, `root` to fall back to (the same clone's <body>).
    const doc = document.cloneNode(true) as Document;
    return { doc, root: doc.body, baseUrl: document.baseURI, title: document.title, images: [] };
  },
};

const CleanStep: Module<ReaderPipelineValue, ReaderPipelineValue> = {
  id: 'reader-mode-converter/clean',
  label: 'Clean content (Readability)',
  needs: ['dom'],
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
  label: 'Reader Mode Converter',
  description:
    'Distills the page into Markdown, fetching images so they can be reviewed and downloaded as a bundle.',
  subModules: [LoadDomStep, CleanStep, FetchImagesStep, ConvertMarkdownStep],
  uiSchema: { kind: 'action', actionLabel: 'Convert to Markdown', resultView: 'files' },
}) as Module<void, ReaderModeResult>;
