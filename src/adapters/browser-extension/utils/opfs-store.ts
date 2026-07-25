/**
 * OPFS-backed sequential file staging for the Merge page's segment download (docs/ROADMAP.md #8.5)
 * — replaces per-segment IndexedDB records (blob-store.ts) with ONE file per run, written via
 * `FileSystemWritableFileStream`. `ffmpeg.writeFile`/MEMFS is still a real wasm-heap ceiling on its
 * own (that part isn't fixable from the staging side), but staging here removes the other half:
 * no N-record IndexedDB roundtrip, and the finished `File` is file-backed —
 * `URL.createObjectURL`/`ffmpeg.mount('WORKERFS', ...)` on it load nothing into RAM up front. That's
 * what makes the "concatenated TS is already a playable file" fast path in ui/merge/main.ts viable
 * for multi-GB streams.
 *
 * `blob-store.ts` (IndexedDB) is untouched — it stays the right tool for http-error-mocker's small
 * one-shot upload blobs; this module exists for a different shape of problem (hundreds of
 * sequential writes into one growing file).
 */

const RUN_DIR = 'synapse-merge-runs';

async function getRunDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(RUN_DIR, { create: true });
}

export interface OpfsRun {
  /** Appends at the run's current write offset. Callers writing segments out of order (docs/
   * ROADMAP.md #8.3's concurrent pool) must serialize calls to this themselves — this object has no
   * queue of its own. */
  write(bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  /** Closes the writable and returns the finished file — file-backed, safe to hand to
   * `URL.createObjectURL` or `ffmpeg.mount` without loading it into RAM. */
  finish(): Promise<File>;
  /** Best-effort: aborts the in-progress write and deletes the partial file. */
  abort(): Promise<void>;
}

export async function createOpfsRun(runId: string): Promise<OpfsRun> {
  const dir = await getRunDir();
  const handle = await dir.getFileHandle(runId, { create: true });
  const writable = await handle.createWritable();
  let offset = 0;
  return {
    async write(bytes) {
      await writable.write({ type: 'write', position: offset, data: bytes });
      offset += bytes.byteLength;
    },
    async finish() {
      await writable.close();
      return handle.getFile();
    },
    async abort() {
      try {
        await writable.abort();
      } catch {
        // Already closed — fine, still fall through to delete the (possibly partial) file.
      }
      await removeOpfsRun(runId);
    },
  };
}

/** Best-effort cleanup, called once a run's output(s) are downloaded (or on error) — same
 * "not on the critical path" posture as blob-store.ts's `deleteBlob`. Not finding `runId` is a
 * normal outcome (already cleaned up), not an error. */
export async function removeOpfsRun(runId: string): Promise<void> {
  try {
    const dir = await getRunDir();
    await dir.removeEntry(runId);
  } catch {
    // Never existed, or already removed — fine.
  }
}
