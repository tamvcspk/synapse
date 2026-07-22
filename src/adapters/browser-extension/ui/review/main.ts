import '@picocss/pico/css/pico.min.css';
import './review.css';
import { deleteBlob, getBlob } from '../../utils/blob-store';
import { buildZip, type ZipEntryInput } from '../../../../shared/zip';

/**
 * Review page (docs/ROADMAP.md #3) — a standalone Tab (opened via `chrome.tabs.create` from the
 * popup, see `ui/popup/review-handoff.ts`) for an Action-schema module's `resultView: 'files'`
 * result: a big, "print-preview"-style read-only look at the Markdown before committing to it,
 * plus a Download ZIP action bundling the Markdown with whatever image files were fetched
 * alongside it. Scoped to a single `?reviewId=` — one-shot, the payload is consumed and cleared
 * from `chrome.storage.session` on load, same "no module list of its own" scoping as the Dashboard.
 */

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

function slugify(title: string): string {
  const slug = title
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

  const header = document.createElement('header');
  const h1 = document.createElement('h1');
  h1.textContent = payload.title;
  header.append(h1);

  const textarea = document.createElement('textarea');
  textarea.className = 'review-markdown';
  textarea.readOnly = true;
  textarea.value = payload.markdown;

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'secondary';
  copyBtn.textContent = 'Copy';
  copyBtn.onclick = () => {
    void navigator.clipboard.writeText(payload.markdown);
    copyBtn.textContent = 'Copied!';
    setTimeout(() => {
      copyBtn.textContent = 'Copy';
    }, 1200);
  };

  const downloadBtn = document.createElement('button');
  downloadBtn.type = 'button';
  downloadBtn.textContent = `Download ZIP (${payload.fileRefs.length} image${payload.fileRefs.length === 1 ? '' : 's'})`;
  downloadBtn.onclick = () => void handleDownload(payload, downloadBtn);

  const actions = document.createElement('div');
  actions.className = 'form-actions';
  actions.append(copyBtn, downloadBtn);

  root.append(header, textarea, actions);
}

async function handleDownload(payload: ReviewPayload, downloadBtn: HTMLButtonElement): Promise<void> {
  downloadBtn.disabled = true;
  const originalText = downloadBtn.textContent;
  downloadBtn.textContent = 'Building ZIP...';

  try {
    const slug = slugify(payload.title);
    const entries: ZipEntryInput[] = [{ name: `${slug}.md`, data: new TextEncoder().encode(payload.markdown) }];

    for (const ref of payload.fileRefs) {
      const blob = await getBlob(ref.blobRef);
      if (blob) entries.push({ name: `images/${ref.fileName}`, data: new Uint8Array(blob.bytes) });
    }

    const zipBytes = buildZip(entries);
    const blobUrl = URL.createObjectURL(new Blob([zipBytes], { type: 'application/zip' }));
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = `${slug}.zip`;
    anchor.click();
    URL.revokeObjectURL(blobUrl);

    // Best-effort cleanup now that the bytes have been zipped — orphaned only if the tab closes
    // before this point, same "best-effort, not guaranteed" treatment as mock-file blob cleanup.
    for (const ref of payload.fileRefs) void deleteBlob(ref.blobRef);
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.textContent = originalText;
  }
}

void load();
