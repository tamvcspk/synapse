import { base64ToBytes, putBlob } from '../../utils/blob-store';

/**
 * Handoff from an Action-schema Module's `run()` result (docs/ROADMAP.md #3, `resultView: 'files'`)
 * to the standalone Review tab (`ui/review/`). Deliberately a structural shape check rather than
 * importing a concrete Module's result type (e.g. reader-mode-converter's `ReaderModeResult`) — the
 * popup stays generic across any Action module that opts into this `resultView`, matching how
 * `CollectionCommand<T>` stays generic across Collection-schema modules elsewhere in this codebase.
 */
export interface ReviewFile {
  fileName: string;
  mimeType: string;
  base64: string;
}

export interface ReviewData {
  title: string;
  markdown: string;
  files: ReviewFile[];
}

export interface ReviewHandoffResult {
  ok: boolean;
  reviewId?: string;
  error?: string;
}

function isReviewData(data: unknown): data is ReviewData {
  if (!data || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  return (
    typeof record.title === 'string' &&
    typeof record.markdown === 'string' &&
    Array.isArray(record.files) &&
    record.files.every(
      (f) =>
        f &&
        typeof f === 'object' &&
        typeof (f as Record<string, unknown>).fileName === 'string' &&
        typeof (f as Record<string, unknown>).mimeType === 'string' &&
        typeof (f as Record<string, unknown>).base64 === 'string',
    )
  );
}

/**
 * Stashes the result's image bytes into IndexedDB (popup shares the extension's IndexedDB origin
 * with the background/Dashboard — unlike a content script, see blob-store.ts's doc comment) and
 * the small text payload into `chrome.storage.session` (cleared on browser close, no separate
 * permission beyond the existing `storage` one) under a fresh id, for the Review page to pick up.
 */
export async function openReviewPage(data: unknown): Promise<ReviewHandoffResult> {
  if (!isReviewData(data)) {
    return { ok: false, error: "This module's result is not in the expected {title, markdown, files} shape." };
  }

  const reviewId = crypto.randomUUID();
  const fileRefs: { fileName: string; blobRef: string }[] = [];

  for (const file of data.files) {
    const blobRef = `review:${reviewId}:${file.fileName}`;
    await putBlob(blobRef, { mimeType: file.mimeType, fileName: file.fileName, bytes: base64ToBytes(file.base64) });
    fileRefs.push({ fileName: file.fileName, blobRef });
  }

  await chrome.storage.session.set({
    [`synapse:review:${reviewId}`]: { title: data.title, markdown: data.markdown, fileRefs },
  });

  return { ok: true, reviewId };
}
