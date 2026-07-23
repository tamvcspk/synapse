import van from 'vanjs-core';
import '@picocss/pico/css/pico.min.css';
import './review.css';
import { deleteBlob, getBlob } from '../../utils/blob-store';
import { buildZip, type ZipEntryInput } from '../../../../shared/zip';

/**
 * Review page (docs/ROADMAP.md #3) — a standalone Tab (opened via `chrome.tabs.create` from the
 * popup, see `ui/popup/review-handoff.ts`) for an Action-schema module's `resultView: 'files'`
 * result: a big, "print-preview"-style look at the Markdown before committing to it (editable, not
 * read-only — the user may want to fix up the text or drop images before downloading), plus a
 * Download ZIP action bundling the Markdown with whatever image files were fetched alongside it
 * (optional — see the "Download images" toggle). Scoped to a single `?reviewId=` — one-shot, the
 * payload is consumed and cleared from `chrome.storage.session` on load, same "no module list of
 * its own" scoping as the Dashboard.
 */

const { header, h1, label, input, textarea, div, button } = van.tags;

interface ReviewFileRef {
  fileName: string;
  blobRef: string;
}

interface ReviewPayload {
  title: string;
  markdown: string;
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

// Unicode "Combining Diacritical Marks" block — covers the tone/vowel marks NFD below decomposes
// Vietnamese letters into (grave, breve, horn, circumflex, ...). Written as numeric bounds rather
// than a regex character class literal to avoid embedding the actual combining characters in this
// source file (indistinguishable from each other at a glance, easy to mis-paste/mis-copy).
const COMBINING_MARK_MIN = 0x0300;
const COMBINING_MARK_MAX = 0x036f;

/** Strips diacritics before the a-z/0-9 filter below, so e.g. "Lan dau cong bo" (from "Lan dau
 * cong bo" with Vietnamese tone/vowel marks) survives instead of every accented letter being
 * dropped outright, which used to leave only stray consonants (e.g. "l-n-u-c-ng-b"). NFD
 * decomposes most Vietnamese letters into a base letter + combining mark, filtered out here by
 * code point; "d with stroke" (đ/Đ) doesn't have a canonical decomposition (it's its own letter,
 * not base+mark), so it's replaced explicitly. */
function stripDiacritics(text: string): string {
  return Array.from(text.normalize('NFD'))
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < COMBINING_MARK_MIN || code > COMBINING_MARK_MAX;
    })
    .join('')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function slugify(title: string): string {
  const slug = stripDiacritics(title)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'reader-mode';
}

async function load(): Promise<void> {
  if (!reviewId) {
    renderError("No review to show — open this page via a module's result in the Synapse popup.");
    return;
  }

  const key = `synapse:review:${reviewId}`;
  const stored = await chrome.storage.session.get(key);
  const payload = stored[key] as ReviewPayload | undefined;
  if (!payload) {
    renderError('This review has expired or was already opened.');
    return;
  }
  await chrome.storage.session.remove(key); // one-shot — don't linger in session storage

  render(payload);
}

function render(payload: ReviewPayload): void {
  document.title = `Synapse — ${payload.title}`;
  root.replaceChildren();

  // Base name only (no extension) — editable, initially generated as a kebab-case slug of the
  // article title; used for both the .md entry inside the zip and the zip's own download name.
  const fileNameInput = input({ type: 'text', value: slugify(payload.title) });

  // Editable, not read-only (docs/ROADMAP.md #3's Review page rebuild) — the user may want to fix
  // up the converted text before downloading, so Copy/Download both read its *current* value
  // rather than the original `payload.markdown` string.
  const contentArea = textarea({ class: 'review-markdown' }, payload.markdown);

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
  downloadBtn.onclick = () => void handleDownload(payload, fileNameInput, contentArea, downloadImagesInput, downloadBtn);

  van.add(
    root,
    header(h1(payload.title)),
    div({ class: 'review-filename' }, label('File name'), fileNameInput),
    contentArea,
    div(
      { class: 'form-actions' },
      label(downloadImagesInput, ` Download images (${payload.fileRefs.length})`),
      copyBtn,
      downloadBtn,
    ),
  );
}

async function handleDownload(
  payload: ReviewPayload,
  fileNameInput: HTMLInputElement,
  contentArea: HTMLTextAreaElement,
  downloadImagesInput: HTMLInputElement,
  downloadBtn: HTMLButtonElement,
): Promise<void> {
  downloadBtn.disabled = true;
  const originalText = downloadBtn.textContent;
  downloadBtn.textContent = 'Building ZIP...';

  try {
    const slug = fileNameInput.value.trim() || slugify(payload.title);
    const includeImages = downloadImagesInput.checked;
    const entries: ZipEntryInput[] = [{ name: `${slug}.md`, data: new TextEncoder().encode(contentArea.value) }];

    if (includeImages) {
      for (const ref of payload.fileRefs) {
        const blob = await getBlob(ref.blobRef);
        if (blob) entries.push({ name: `images/${ref.fileName}`, data: new Uint8Array(blob.bytes) });
      }
    }

    const zipBytes = buildZip(entries);
    const blobUrl = URL.createObjectURL(new Blob([zipBytes], { type: 'application/zip' }));
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = `${slug}.zip`;
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
