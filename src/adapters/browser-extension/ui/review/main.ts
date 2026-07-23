import van from 'vanjs-core';
import '@picocss/pico/css/pico.min.css';
import './review.css';
import { deleteBlob, getBlob } from '../../utils/blob-store';
import { buildZip, type ZipEntryInput } from '../../../../shared/zip';
import { slugify } from '../../../../shared/slugify';

/**
 * Review page (docs/ROADMAP.md #3, extended #1) — a standalone Tab (opened via `chrome.tabs.create`
 * from the popup, see `ui/popup/review-handoff.ts`) for an Action-schema module's `resultView:
 * 'files'` result: a big, "print-preview"-style look at the Markdown before committing to it
 * (editable, not read-only), plus a Download ZIP action bundling every page's Markdown — laid out
 * as a file-per-page structure mirroring the crawled site (docs/ROADMAP.md #1's Crawl & Convert
 * Site), not one giant concatenated file — plus whatever image files were fetched alongside them
 * (optional, see the "Download images" toggle). Scoped to a single `?reviewId=` — one-shot, the
 * payload is consumed and cleared from `chrome.storage.session` on load, same "no module list of
 * its own" scoping as the Dashboard.
 */

const { header, h1, label, input, select, option, textarea, div, button } = van.tags;

interface ReviewFileRef {
  fileName: string;
  blobRef: string;
}

interface ReviewPage {
  path: string;
  title: string;
  markdown: string;
}

interface ReviewPayload {
  title: string;
  pages: ReviewPage[];
  fileRefs: ReviewFileRef[];
}

const root = document.getElementById('root')!;
const reviewId = new URLSearchParams(location.search).get('reviewId');

function renderError(message: string): void {
  root.replaceChildren();
  const p = document.createElement('p');
  p.textContent = message;
  root.append(p);
}

async function load(): Promise<void> {
  if (!reviewId) {
    renderError("No review to show — open this page via a module's result in the Synapse popup.");
    return;
  }

  const key = `synapse:review:${reviewId}`;
  const stored = await chrome.storage.session.get(key);
  const payload = stored[key] as ReviewPayload | undefined;
  if (!payload || payload.pages.length === 0) {
    renderError('This review has expired or was already opened.');
    return;
  }
  await chrome.storage.session.remove(key); // one-shot — don't linger in session storage

  render(payload);
}

function render(payload: ReviewPayload): void {
  document.title = `Synapse — ${payload.title}`;
  root.replaceChildren();

  let selectedIndex = 0;

  // Editable, not read-only — the user may want to fix up the converted text before downloading.
  const contentArea = textarea({ class: 'review-markdown' }, payload.pages[0]!.markdown);

  // Single page (the ordinary "Convert" action): an editable base-name input, same UX as before —
  // initially a kebab-case slug of the page's own title, used for that one .md entry in the zip.
  // Multiple pages (Crawl & Convert Site): a read-only select of the file-per-page paths already
  // derived from each page's URL (docs/ROADMAP.md #1) — picking one loads it into the textarea,
  // saving whatever was just edited in the previously-selected page first.
  let fileNameInput: HTMLInputElement | undefined;
  let pathControl: HTMLElement;

  if (payload.pages.length === 1) {
    fileNameInput = input({ type: 'text', value: payload.pages[0]!.path.replace(/\.md$/, '') });
    pathControl = div({ class: 'review-filename' }, label('File name'), fileNameInput);
  } else {
    const pageSelect = select(
      {
        onchange: (e: Event) => {
          payload.pages[selectedIndex]!.markdown = contentArea.value;
          selectedIndex = Number((e.target as HTMLSelectElement).value);
          contentArea.value = payload.pages[selectedIndex]!.markdown;
        },
      },
      ...payload.pages.map((page, i) => option({ value: String(i) }, page.path)),
    );
    pathControl = div({ class: 'review-filename' }, label('Page'), pageSelect);
  }

  const downloadImagesInput = input({
    type: 'checkbox',
    checked: true,
    disabled: payload.fileRefs.length === 0,
  });

  const copyBtn = button({ type: 'button', class: 'secondary' }, 'Copy');
  copyBtn.onclick = () => {
    void navigator.clipboard.writeText(contentArea.value);
    copyBtn.textContent = 'Copied!';
    setTimeout(() => {
      copyBtn.textContent = 'Copy';
    }, 1200);
  };

  const downloadBtn = button({ type: 'button' }, 'Download ZIP');
  downloadBtn.onclick = () =>
    void handleDownload(
      payload,
      { fileNameInput, contentArea, getSelectedIndex: () => selectedIndex },
      downloadImagesInput,
      downloadBtn,
    );

  van.add(
    root,
    header(h1(payload.title)),
    pathControl,
    contentArea,
    div(
      { class: 'form-actions' },
      label(downloadImagesInput, ` Download images (${payload.fileRefs.length})`),
      copyBtn,
      downloadBtn,
    ),
  );
}

interface EditControls {
  /** Only present for a single-page result — renaming a crawled page's path isn't offered
   * (editing hundreds of paths individually isn't practical; the derived-from-URL path is kept
   * as-is for those). */
  fileNameInput: HTMLInputElement | undefined;
  contentArea: HTMLTextAreaElement;
  getSelectedIndex: () => number;
}

async function handleDownload(
  payload: ReviewPayload,
  controls: EditControls,
  downloadImagesInput: HTMLInputElement,
  downloadBtn: HTMLButtonElement,
): Promise<void> {
  downloadBtn.disabled = true;
  const originalText = downloadBtn.textContent;
  downloadBtn.textContent = 'Building ZIP...';

  try {
    // Persist whatever's currently shown in the textarea back into its page before zipping — the
    // user may be mid-edit on the page they're currently looking at.
    payload.pages[controls.getSelectedIndex()]!.markdown = controls.contentArea.value;

    if (controls.fileNameInput) {
      const base = controls.fileNameInput.value.trim() || slugify(payload.pages[0]!.title, 'reader-mode');
      payload.pages[0]!.path = `${base}.md`;
    }

    const includeImages = downloadImagesInput.checked;
    const entries: ZipEntryInput[] = payload.pages.map((page) => ({
      name: page.path,
      data: new TextEncoder().encode(page.markdown),
    }));

    if (includeImages) {
      for (const ref of payload.fileRefs) {
        const blob = await getBlob(ref.blobRef);
        // `ref.fileName` already carries its own `images/...` path (see
        // reader-mode-converter.module.ts's `localPath`/`buildCrawlResult`) — used as-is, not
        // re-prefixed.
        if (blob) entries.push({ name: ref.fileName, data: new Uint8Array(blob.bytes) });
      }
    }

    const zipBytes = buildZip(entries);
    const blobUrl = URL.createObjectURL(new Blob([zipBytes], { type: 'application/zip' }));
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = `${slugify(payload.title, 'reader-mode')}.zip`;
    anchor.click();
    URL.revokeObjectURL(blobUrl);

    // Best-effort cleanup now that the bytes have actually been zipped — only for images that
    // were included this time (leave the rest, in case the user downloads again with the toggle
    // on), and only orphaned if the tab closes before this point (same "best-effort, not
    // guaranteed" treatment as mock-file blob cleanup elsewhere in this codebase).
    if (includeImages) {
      for (const ref of payload.fileRefs) void deleteBlob(ref.blobRef);
    }
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.textContent = originalText;
  }
}

void load();
