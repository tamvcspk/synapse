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

const DB_NAME = 'synapse-blobs';
const DB_VERSION = 1;
const STORE_NAME = 'blobs';

export interface StoredBlob {
  mimeType: string;
  fileName: string;
  bytes: ArrayBuffer;
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

export async function putBlob(id: string, blob: StoredBlob): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(blob, id);
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
