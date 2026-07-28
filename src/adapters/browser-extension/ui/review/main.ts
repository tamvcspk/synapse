import van from 'vanjs-core';
import '@picocss/pico/css/pico.min.css';
import './review.css';
import { slugify } from '../../../../shared/slugify';
import { downloadReviewZip } from '../review-zip';
import type { ReviewPayload } from '../review-handoff';

/**
 * Review page (docs/ROADMAP.md #3, extended #1, §9.1) — a standalone Tab for a converted page (or
 * crawl) result: a big, "print-preview"-style look at the Markdown before committing to it
 * (editable, not read-only), plus a Download ZIP action bundling every page's Markdown — laid out
 * as a file-per-page structure mirroring the crawled site (docs/ROADMAP.md #1's Crawl & Convert
 * Site), not one giant concatenated file — plus whatever image files were fetched alongside them
 * (optional, see the "Download images" toggle).
 *
 * Scoped to a single `?reviewId=` — one-shot, the payload is consumed and cleared from
 * `chrome.storage.session` on load (same "no module list of its own" scoping as the Dashboard).
 * Reached either via the popup's fast Action-schema path (`ui/review-handoff.ts`'s
 * `openReviewPage`) or via the Side Panel's "Open in new tab" (docs/ROADMAP.md §9.1's in-page-icon
 * → Side Panel flow, `ui/side-panel/main.ts`'s `publishReviewSession` call) — both just write the
 * same `ReviewPayload` shape into session storage under a fresh id, so this page doesn't need to
 * know which one sent it.
 */

const { header, h1, label, input, select, option, textarea, div, button } = van.tags;

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
    renderError("No review to show — open this page via a module's result in the Synapse popup or Side Panel.");
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

    await downloadReviewZip(payload, downloadImagesInput.checked);
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.textContent = originalText;
  }
}

void load();
