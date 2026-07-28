import { deleteBlob, getBlob } from '../utils/blob-store';
import { buildZip, type ZipEntryInput } from '../../../shared/zip';
import { slugify } from '../../../shared/slugify';
import type { ReviewPayload } from './review-handoff';

/**
 * Builds the ZIP (file-per-page Markdown, docs/ROADMAP.md #1, plus optionally the fetched images)
 * and triggers a browser download — shared by the Review tab (`ui/review/main.ts`, after applying
 * whatever edits are pending in its textarea/filename input) and the Side Panel's inline quick
 * download (docs/ROADMAP.md §9.1, no editing step, `payload` used as-is).
 */
export async function downloadReviewZip(payload: ReviewPayload, includeImages: boolean): Promise<void> {
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

  // Best-effort cleanup now that the bytes have actually been zipped — only for images that were
  // included this time (leave the rest, in case the user downloads again with the toggle on), and
  // only orphaned if the tab/panel closes before this point (same "best-effort, not guaranteed"
  // treatment as mock-file blob cleanup elsewhere in this codebase).
  if (includeImages) {
    for (const ref of payload.fileRefs) void deleteBlob(ref.blobRef);
  }
}
