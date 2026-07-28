import { base64ToBytes, putBlob } from '../utils/blob-store';

/**
 * Handoff to the standalone Review tab (`ui/review/`) — from either an Action-schema Module's
 * `run()` result (docs/ROADMAP.md #3, `resultView: 'files'`, the popup's fast path,
 * `openReviewPage` below) or the Side Panel's in-page-icon-triggered job (docs/ROADMAP.md §9.1,
 * `ui/side-panel/main.ts` — stores the result as soon as it arrives via the lower-level
 * `storeReviewFiles`, and only calls `publishReviewSession` if/when the user clicks "Open in new
 * tab"). Deliberately a structural shape check rather than importing a concrete Module's result
 * type (e.g. reader-mode-converter's `ReaderModeResult`) — stays generic across any producer of
 * this shape, matching how `CollectionCommand<T>` stays generic across Collection-schema modules
 * elsewhere in this codebase.
 *
 * Lives at `ui/` (not `ui/popup/`) since both the popup and the Side Panel need it.
 */
export interface ReviewFile {
  fileName: string;
  mimeType: string;
  base64: string;
}

/** One file-per-page entry (docs/ROADMAP.md #1) — a single-page conversion has exactly one of
 * these, Crawl & Convert Site has one per successfully-converted page. */
export interface ReviewPage {
  path: string;
  title: string;
  markdown: string;
}

export interface ReviewData {
  title: string;
  pages: ReviewPage[];
  files: ReviewFile[];
}

export interface ReviewFileRef {
  fileName: string;
  blobRef: string;
}

/** What the Review page (`ui/review/main.ts`) actually renders, read back from
 * `chrome.storage.session` — also what the Side Panel (docs/ROADMAP.md §9.1) holds in memory
 * between storing a result's files and either downloading a ZIP directly or publishing a session
 * for "Open in new tab". */
export interface ReviewPayload {
  title: string;
  pages: ReviewPage[];
  fileRefs: ReviewFileRef[];
}

export interface ReviewHandoffResult {
  ok: boolean;
  reviewId?: string;
  error?: string;
}

export function isReviewData(data: unknown): data is ReviewData {
  if (!data || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  return (
    typeof record.title === 'string' &&
    Array.isArray(record.pages) &&
    record.pages.every(
      (p) =>
        p &&
        typeof p === 'object' &&
        typeof (p as Record<string, unknown>).path === 'string' &&
        typeof (p as Record<string, unknown>).title === 'string' &&
        typeof (p as Record<string, unknown>).markdown === 'string',
    ) &&
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

/** Stashes a result's image bytes into IndexedDB (an extension page — popup, Side Panel, Review
 * tab, Dashboard — shares the extension's IndexedDB origin, unlike a content script; see
 * blob-store.ts's doc comment) under `reviewId`, returning the `blobRef`s the Review page reads
 * back via `getBlob`. Split out from `openReviewPage` below so the Side Panel (§9.1) can do just
 * this part itself, as soon as a result arrives — before the user has decided whether to open a
 * Review tab at all. */
export async function storeReviewFiles(reviewId: string, files: ReviewFile[]): Promise<ReviewFileRef[]> {
  const fileRefs: ReviewFileRef[] = [];
  for (const file of files) {
    const blobRef = `review:${reviewId}:${file.fileName}`;
    await putBlob(blobRef, { mimeType: file.mimeType, fileName: file.fileName, bytes: base64ToBytes(file.base64) });
    fileRefs.push({ fileName: file.fileName, blobRef });
  }
  return fileRefs;
}

/** Publishes an already-stored payload (files already run through `storeReviewFiles`) into
 * `chrome.storage.session` (cleared on browser close, no separate permission beyond the existing
 * `storage` one) under `reviewId`, for the Review page to pick up on load. Split out from
 * `openReviewPage` below so a caller that already has `fileRefs` in hand — the Side Panel
 * (docs/ROADMAP.md §9.1), which stores files as soon as a result arrives but only publishes a
 * session if/when the user clicks "Open in new tab" — doesn't have to re-store them. */
export async function publishReviewSession(reviewId: string, payload: ReviewPayload): Promise<void> {
  await chrome.storage.session.set({ [`synapse:review:${reviewId}`]: payload });
}

/**
 * Fast-path handoff: the caller (popup) already has the full result in hand and is about to open
 * a fresh Review tab for it — stores images (`storeReviewFiles`) plus the small text payload into
 * `chrome.storage.session` under a fresh id, for the Review page to pick up on load.
 */
export async function openReviewPage(data: unknown): Promise<ReviewHandoffResult> {
  if (!isReviewData(data)) {
    return { ok: false, error: "This module's result is not in the expected {title, pages, files} shape." };
  }

  const reviewId = crypto.randomUUID();
  const fileRefs = await storeReviewFiles(reviewId, data.files);
  await publishReviewSession(reviewId, { title: data.title, pages: data.pages, fileRefs });

  return { ok: true, reviewId };
}
