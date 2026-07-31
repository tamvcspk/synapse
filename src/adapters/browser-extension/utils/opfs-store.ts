/**
 * OPFS-backed sequential file staging for the download engine's segment download (docs/ROADMAP.md
 * #8.5, ported into the download engine by §8.1, split into features/media/download/ by §11.2) — replaces per-segment IndexedDB records
 * (blob-store.ts) with ONE file per run, written via `FileSystemWritableFileStream`.
 * `ffmpeg.writeFile`/MEMFS is still a real wasm-heap ceiling on its own (that part isn't fixable
 * from the staging side), but staging here removes the other half: no N-record IndexedDB roundtrip,
 * and the finished `File` is file-backed — `URL.createObjectURL`/`ffmpeg.mount('WORKERFS', ...)` on
 * it load nothing into RAM up front. That's what makes the "concatenated TS is already a playable
 * file" fast path in features/media/download/output.offscreen.ts viable for multi-GB streams. `navigator.storage.
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
  /** The sequential (no-`position`) write cursor's current value — meaningless for a run using only
   * positional writes (§8.2's turbo, whose cursor never advances). docs/ROADMAP.md §8.12 reads this
   * right after each segment's write settles to record a checkpoint's `lastConfirmedByteOffset`. */
  bytesWritten(): number;
  /**
   * docs/ROADMAP.md §8.12 — found via a REAL crash-and-resume test that failed every time: a
   * `FileSystemWritableFileStream` buffers every `write()` into a private swap file — **nothing is
   * visible via `handle.getFile()`, and nothing is durable on disk, until `close()` actually runs**.
   * A long-lived `OpfsRun` (one per HLS job, open for the job's entire duration) never closes until
   * the job finishes, so `bytesWritten()`'s tracked offset had no relationship at all to what
   * `tryResumeOpfsRun` could actually read back after a crash — the file always looked "smaller than
   * expected," every single time, because none of it had ever really been committed.
   *
   * `commit()` closes the current writable (forcing everything written so far to land in the real
   * file) and immediately reopens a fresh one on the SAME file via
   * `createWritable({keepExistingData: true})` so writing can continue exactly where it left off —
   * `write()`'s explicit `position` argument (never relying on the stream's own internal cursor)
   * means a freshly reopened stream continues correctly regardless. Only call this occasionally
   * (see features/media/download/segment-pipeline.offscreen.ts's checkpoint cadence): `keepExistingData: true` re-copies the file's
   * ENTIRE existing content into a new swap file, so this is O(current file size), not O(1) — cheap
   * for a small file, real cost for a multi-hundred-MB one. Rethrows on failure — the caller must
   * treat a failed commit as "this checkpoint round didn't happen," not silently pretend it did.
   */
  commit(): Promise<void>;
}

function wrapWritable(runId: string, handle: FileSystemFileHandle, initialWritable: FileSystemWritableFileStream, initialOffset: number): OpfsRun {
  let offset = initialOffset;
  let stream = initialWritable;
  return {
    async write(bytes, position) {
      await stream.write({ type: 'write', position: position ?? offset, data: bytes });
      if (position === undefined) offset += bytes.byteLength;
    },
    async finish() {
      await stream.close();
      return handle.getFile();
    },
    async abort() {
      try {
        await stream.abort();
      } catch {
        // Already closed — fine, still fall through to delete the (possibly partial) file.
      }
      await removeOpfsRun(runId);
    },
    bytesWritten() {
      return offset;
    },
    async commit() {
      await stream.close();
      stream = await handle.createWritable({ keepExistingData: true });
    },
  };
}

export async function createOpfsRun(runId: string): Promise<OpfsRun> {
  const dir = await getRunDir();
  const handle = await dir.getFileHandle(runId, { create: true });
  const writable = await handle.createWritable();
  return wrapWritable(runId, handle, writable, 0);
}

/**
 * docs/ROADMAP.md §8.12 — reopens a PREVIOUSLY created run (never a fresh `runId`) to continue an
 * interrupted HLS job, picking up exactly where a persisted `DownloadJobCheckpoint` says it left
 * off. Returns `undefined` for every case the caller must treat as "cannot resume safely, start
 * over" instead of throwing — a missing file, or a file SMALLER than the checkpoint claims (the
 * checkpoint was saved later than what actually landed on disk, e.g. a crash mid-write) both mean
 * the checkpoint cannot be trusted. A file LARGER than or equal to `truncateToOffset` is trusted up
 * to exactly that many bytes — `truncate()` cuts off anything past it (which can only be the tail
 * end of whatever segment was mid-write when the interruption happened, never a *validated* later
 * segment, since `lastConfirmedByteOffset` is only ever recorded once a write has settled).
 *
 * `createWritable({keepExistingData: true})` on a file whose PREVIOUS writable was never closed
 * (the exact §8.10/§8.9 scenario — pausing, then killing the Offscreen Document before it could
 * `close()`/`abort()`) is untested against a real browser — if the same lower-level storage-bucket
 * lock that produced `InvalidStateError` there also blocks re-acquiring a writable on this specific
 * file (as opposed to just listing/deleting it, which §8.9's sweep already proved works), this
 * throws and the caller must treat that as "cannot resume" too, not crash the whole engine.
 */
export async function tryResumeOpfsRun(runId: string, truncateToOffset: number): Promise<OpfsRun | undefined> {
  const dir = await getRunDir();
  let handle: FileSystemFileHandle;
  try {
    handle = await dir.getFileHandle(runId);
  } catch {
    return undefined; // File never existed, or was already swept — nothing to resume.
  }
  const file = await handle.getFile();
  if (file.size < truncateToOffset) return undefined; // Checkpoint claims more than is actually on disk — don't trust it.
  try {
    const writable = await handle.createWritable({ keepExistingData: true });
    await writable.truncate(truncateToOffset);
    return wrapWritable(runId, handle, writable, truncateToOffset);
  } catch {
    return undefined; // See this function's doc comment — an untested lock scenario, not assumed safe.
  }
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
 * Every entry under `RUN_DIR` used to be considered short-lived unconditionally — the lifetime of
 * exactly one job in one Offscreen Document, safe to wipe wholesale on every fresh startup since
 * MV3 only ever allows one such document to exist. docs/ROADMAP.md §8.12 changes that for exactly
 * one case: a run whose `opfsRunId` is still referenced by a persisted `DownloadJobCheckpoint` is
 * NOT stale — it's precisely the file a resume needs to reopen. `keepRunIds` (the checkpoint list's
 * `opfsRunId`s, gathered by the caller BEFORE calling this — see ui/offscreen/main.ts) is the
 * exclusion list; everything else is still swept exactly as before. A checkpoint whose file turns
 * out unusable at actual resume time (missing, or smaller than the checkpoint claims) is cleaned up
 * by the resume path itself (features/media/download/engine.offscreen.ts), not here — this sweep only ever decides
 * "keep or delete," never validates.
 */
export async function sweepStaleOpfsRuns(keepRunIds: ReadonlySet<string> = new Set()): Promise<void> {
  try {
    const dir = await getRunDir();
    const staleNames: string[] = [];
    for await (const name of dir.keys()) {
      if (!keepRunIds.has(name)) staleNames.push(name);
    }
    await Promise.all(staleNames.map((name) => dir.removeEntry(name).catch(() => {})));
  } catch {
    // Best-effort — must never block engine startup on this.
  }
}
