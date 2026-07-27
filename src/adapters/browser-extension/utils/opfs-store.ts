/**
 * OPFS-backed sequential file staging for the download engine's segment download (docs/ROADMAP.md
 * #8.5, ported into utils/download-engine.ts by §8.1) — replaces per-segment IndexedDB records
 * (blob-store.ts) with ONE file per run, written via `FileSystemWritableFileStream`.
 * `ffmpeg.writeFile`/MEMFS is still a real wasm-heap ceiling on its own (that part isn't fixable
 * from the staging side), but staging here removes the other half: no N-record IndexedDB roundtrip,
 * and the finished `File` is file-backed — `URL.createObjectURL`/`ffmpeg.mount('WORKERFS', ...)` on
 * it load nothing into RAM up front. That's what makes the "concatenated TS is already a playable
 * file" fast path in download-engine.ts viable for multi-GB streams. `navigator.storage.
 * getDirectory()` works identically whether the caller is a Tab (the old `ui/merge`) or an Offscreen
 * Document (§8.1's replacement) — this module needed no changes when the engine moved.
 *
 * `blob-store.ts` (IndexedDB) is untouched — it stays the right tool for http-error-mocker's small
 * one-shot upload blobs; this module exists for a different shape of problem (hundreds of
 * sequential writes into one growing file).
 *
 * docs/ROADMAP.md §8.2 — `OpfsRun.write()`'s optional `position` param (added for the turbo
 * multi-connection downloader) is additive: every existing sequential caller omits it and keeps
 * appending exactly as before.
 */

// TypeScript's bundled `lib.dom.d.ts` hasn't caught up to the real File System Access API spec —
// `FileSystemDirectoryHandle` is genuinely async-iterable (`keys()`/`values()`/`entries()`) in every
// browser that implements OPFS, this augmentation only teaches the TYPE CHECKER what already exists
// at runtime.
declare global {
  interface FileSystemDirectoryHandle {
    keys(): AsyncIterableIterator<string>;
  }
}

const RUN_DIR = 'synapse-merge-runs';

async function getRunDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(RUN_DIR, { create: true });
}

export interface OpfsRun {
  /** Default (no `position`): appends at the run's current write offset. Callers writing pieces out
   * of order but wanting to buffer-then-flush-in-sequence (docs/ROADMAP.md #8.3's HLS segment pool)
   * must serialize calls to this themselves — this object has no queue of its own.
   *
   * With `position`: writes those bytes at that EXACT byte offset instead, and does NOT advance the
   * internal sequential-offset counter — docs/ROADMAP.md §8.2's turbo downloader uses this so a few
   * large (potentially hundreds-of-MB) chunks can each land at their own final offset the instant
   * they arrive, regardless of order, without ever buffering more than one chunk's worth of bytes in
   * JS memory at a time (HLS's buffer-then-flush approach only works because its pieces are small and
   * numerous — bounded worst-case buffering; that bound would be unacceptable for a handful of huge
   * chunks). A run must stick to ONE of the two modes throughout its lifetime — mixing plain appends
   * with positional writes in the same run isn't a case any caller needs. */
  write(bytes: Uint8Array<ArrayBuffer>, position?: number): Promise<void>;
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
    async write(bytes, position) {
      await writable.write({ type: 'write', position: position ?? offset, data: bytes });
      if (position === undefined) offset += bytes.byteLength;
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

/**
 * docs/ROADMAP.md §8.9 — called once when a fresh Offscreen Document starts up
 * (ui/offscreen/main.ts), before any job can run. Bug report that motivated this: pausing a job,
 * then removing/reloading the extension mid-pause (so the run's `FileSystemWritableFileStream` never
 * gets a chance to `close()`/`abort()`), then starting a NEW download afterward hit
 * `InvalidStateError: An operation that depends on state cached in an interface object was made but
 * the state had changed since it was read from disk` on the very next `createOpfsRun()` — and the
 * user reported needing a full browser restart (not just remove+reload) to actually clear it,
 * consistent with a lower-level Chromium storage lock outliving the JS context that opened it.
 *
 * Every entry under `RUN_DIR` is meant to be short-lived — the lifetime of exactly one job in one
 * Offscreen Document. A FRESH document starting up (first launch, or replacing one that
 * crashed/was reloaded/was removed) can only ever see entries belonging to a document that's
 * already gone, so sweeping the whole directory here is always safe — never removes a file some
 * OTHER still-running job needs, because there is no other job: this document IS the only one that
 * can exist (MV3's one-offscreen-document-per-extension limit). This can't fully guarantee release
 * of a lower-level browser storage lock (that's outside what JS can control), but it removes the one
 * thing actually in our control and gives the next attempt the best chance of succeeding without a
 * full browser restart.
 */
export async function sweepStaleOpfsRuns(): Promise<void> {
  try {
    const dir = await getRunDir();
    const staleNames: string[] = [];
    for await (const name of dir.keys()) staleNames.push(name);
    await Promise.all(staleNames.map((name) => dir.removeEntry(name).catch(() => {})));
  } catch {
    // Best-effort — must never block engine startup on this.
  }
}
