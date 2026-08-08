/**
 * IndexedDB-backed blob storage for uploaded files (Environment SDK — docs/ROADMAP.md #2.6.1's
 * fake-file support). `chrome.storage.local`'s ~5MB quota for the *entire* extension (plus ~33%
 * inflation if base64-encoded) makes it unfit for image/PDF uploads, so raw bytes live here
 * instead — a MockConfig only ever carries a short `blobRef` string pointing at a record here (see
 * shared/http-mock.ts's `fakeResponseFile`).
 *
 * Usable from any context that shares the extension's own origin: the background service worker
 * and any extension page (Dashboard, popup) both resolve `indexedDB` to the same database. **Not**
 * usable from a content script — a content script's `indexedDB` global resolves to the *page's*
 * origin, not the extension's (unlike `chrome.storage.*`, which is available everywhere). This is
 * why `mechanism: 'main-world'` doesn't support file bodies yet: getting bytes into that MAIN-world
 * payload would need a new push-based relay through the background, not a blob-store change.
 */

import { isExpired } from '../../../shared/ttl';

const DB_NAME = 'synapse-blobs';
const DB_VERSION = 1;
const STORE_NAME = 'blobs';

export interface StoredBlob {
  mimeType: string;
  fileName: string;
  bytes: ArrayBuffer;
  /** docs/ROADMAP.md Track A3 — stamped by `putBlob` itself (never caller-supplied), so every blob
   * this store has ever written carries one for free. Only `sweepStaleReviewBlobs` below reads it —
   * an http-mock fake-response-file blob is tied to a saved `MockConfig` rule's own lifecycle
   * (deleted when the rule is deleted/replaced, see `deleteBlob`'s call sites), never TTL'd by age. */
  createdAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error as Error);
  });
}

/** `createdAt` is stamped here, never accepted from the caller — every existing call site
 * (`item-form-view.ts`, `review-handoff.ts`) predates it and none should have to start passing a
 * timestamp just to keep compiling. */
export async function putBlob(id: string, blob: Omit<StoredBlob, 'createdAt'>): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ ...blob, createdAt: Date.now() } satisfies StoredBlob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error as Error);
    });
  } finally {
    db.close();
  }
}

export async function getBlob(id: string): Promise<StoredBlob | undefined> {
  const db = await openDb();
  try {
    return await new Promise<StoredBlob | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => resolve(req.result as StoredBlob | undefined);
      req.onerror = () => reject(req.error as Error);
    });
  } finally {
    db.close();
  }
}

/** Best-effort cleanup — called when a rule's file is replaced or the rule itself is deleted, so
 * orphaned blobs don't accumulate forever. Not finding `id` is a normal outcome (e.g. a rule that
 * never had a file), not an error. */
export async function deleteBlob(id: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error as Error);
    });
  } finally {
    db.close();
  }
}

const REVIEW_BLOB_ID_PREFIX = 'review:';

/**
 * docs/ROADMAP.md Track A3 — evicts `review:*` blobs (`review-handoff.ts`'s `storeReviewFiles`)
 * older than `maxAgeMs`, called periodically from `background/storage-gc.ts`'s `chrome.alarms`
 * sweep. Scoped to the `review:` prefix ONLY: this object store also holds http-mock's uploaded
 * fake-response files (bare-uuid ids, see `item-form-view.ts`), which are tied to a saved
 * `MockConfig` rule's own lifecycle and must never be swept by age — that's what `deleteBlob`'s
 * explicit call sites are for.
 *
 * A review blob with no `chrome.storage.session` entry pointing at it anymore (cleared by Chrome on
 * browser restart — see `publishReviewSession`) is exactly the orphan this exists for: nothing will
 * ever call `getBlob`/`deleteBlob` for it again otherwise. A pre-existing blob with no `createdAt`
 * (written before this field existed) is treated as already expired (`?? 0`) rather than kept
 * forever with no way to ever become eligible.
 */
/** Returns how many blobs were actually deleted — the caller (`background/storage-gc.ts`) logs it,
 * so "the sweep ran and found nothing eligible" is distinguishable from "the sweep never ran" when
 * verifying this by hand (there is otherwise no other observable effect on a no-op sweep). */
export async function sweepStaleReviewBlobs(maxAgeMs: number, now: number = Date.now()): Promise<number> {
  const db = await openDb();
  try {
    let deleted = 0;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return; // done — resolved by tx.oncomplete below
        const id = cursor.primaryKey as string;
        const blob = cursor.value as StoredBlob;
        if (id.startsWith(REVIEW_BLOB_ID_PREFIX) && isExpired(blob.createdAt ?? 0, maxAgeMs, now)) {
          cursor.delete();
          deleted++;
        }
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error as Error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error as Error);
    });
    return deleted;
  } finally {
    db.close();
  }
}

/** Raw bytes -> base64, for handing a file's content to APIs that want base64 (CDP's
 * `Fetch.fulfillRequest` body) — deliberately not the `btoa(unescape(encodeURIComponent(...)))`
 * trick `debugger-network-interceptor.background.ts` uses elsewhere, since that's for encoding *text*, not
 * for re-encoding bytes that are already binary. */
export function bytesToBase64(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Inverse of `bytesToBase64` — kept here rather than duplicated, unlike
 * `main-world/network-interceptor.ts`'s own copy (that one exists specifically because a
 * MAIN-world bundle can't safely import this file's `indexedDB`-touching functions transitively;
 * this module's own call sites — popup, Dashboard — share the extension's IndexedDB origin, so no
 * such isolation concern applies here). */
export function base64ToBytes(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
