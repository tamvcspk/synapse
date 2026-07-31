import { buildCheckpoint } from '../../../../../shared/download/checkpoint';
import { createOrderedBuffer } from '../../../../../shared/download/ordered-writes';
import { estimateEtaMs, throughputBytesPerSec } from '../../../../../shared/download/progress';
import type { OpfsRun } from '../../../utils/opfs-store';
import { persistCheckpoint } from './background-relay.offscreen';
import { debugLog, emit } from './engine-events.offscreen';
import { noteFetchSettled, type JobControl } from './job-control.offscreen';

/**
 * docs/ROADMAP.md §8.3/§8.12/§11.2 — the VOD pool's WRITE side, extracted from `runJob` (Phase 1:
 * "tách runJob thành SegmentPipeline + JobControl + output"). It used to be six closures over
 * `runJob`'s locals — `pendingWrites`, `nextToWrite`, `writeChain`, `lastCheckpointAt`,
 * `pendingCheckpointSave`, plus `enqueueWrite`/`flushReady` — mutating each other's state in an
 * order nothing enforced. Everything downstream of "these bytes arrived" now lives here, and the
 * ordering rule itself is pure and unit-tested in `shared/download/ordered-writes.ts`.
 *
 * The invariant this exists to hold: segments finish downloading in whatever order the network
 * hands them over, but the output file is one concatenated stream where order IS the content. So
 * out-of-order arrivals buffer until their predecessors land, and the actual OPFS writes are
 * serialized one at a time through a single promise chain.
 */

export interface SegmentPipelineOptions {
  jobId: string;
  control: JobControl;
  opfsRun: OpfsRun;
  /** Segment count from the manifest — the denominator of every progress event. */
  total: number;
  /** Where this run starts writing: 0 normally, or a resume's first un-downloaded index (§8.12). */
  startIndex: number;
  checkpoint: {
    manifestUrl: string;
    opfsRunId: string;
    resolutionLabel?: string | undefined;
  };
}

export interface SegmentPipeline {
  /** Hands segment `index`'s decrypted bytes over. Returns immediately — the write itself is queued
   * and happens once every earlier segment has been written. */
  submit(index: number, bytes: ArrayBuffer): void;
  /** Waits for every queued write to land. Rejects if any of them failed. */
  drain(): Promise<void>;
  /** Waits for queued writes to settle, swallowing errors — for the cancel/error paths, where the
   * file is about to be discarded anyway and a write failure is no longer interesting. */
  drainQuietly(): Promise<void>;
  /** Waits for the most recently fired checkpoint save to reach background. Must be awaited BEFORE
   * a terminal `clearCheckpoint`, or the two can race (see below). */
  flushCheckpoints(): Promise<void>;
}

/**
 * docs/ROADMAP.md §8.12 — periodic, not per-segment: a stream can have hundreds/thousands of
 * segments, and every round costs a `chrome.storage` round-trip PLUS (see `OpfsRun.commit()`'s doc
 * comment) an O(current-file-size) swap-file re-copy inside OPFS itself — closing and reopening the
 * writable is the only way to make bytes actually durable/readable before the run finishes, but it
 * is genuinely not free for a large file. Spaced out much further than the Side Panel's
 * `scheduleRender` (§8.9) coalescing for exactly that reason: this isn't "don't rebuild the DOM
 * 60x/sec," it's "don't re-copy a 500MB file every few seconds."
 */
const CHECKPOINT_INTERVAL_MS = 20_000;

export function createSegmentPipeline(options: SegmentPipelineOptions): SegmentPipeline {
  const { jobId, control, opfsRun, total, startIndex, checkpoint } = options;
  const ordered = createOrderedBuffer<ArrayBuffer>(startIndex);
  let writeChain: Promise<void> = Promise.resolve();
  let lastCheckpointAt = 0;
  // Tracks the most recently FIRED checkpoint save so the job's `finally` block can await it before
  // clearing the checkpoint on completion — without this, the very last save (fired fire-and-forget
  // right as the final segment lands) could still be in flight to background when the completion
  // `clearCheckpoint` message goes out, and arrive AFTER it: a checkpoint for an already-fully-
  // downloaded job would be left behind, resurrecting a stale "Resume available" row for something
  // that doesn't need resuming.
  let pendingCheckpointSave: Promise<void> = Promise.resolve();

  /**
   * docs/ROADMAP.md §8.12 — bugfix found via a REAL crash-and-resume test that failed every time:
   * this used to read `opfsRun.bytesWritten()` and persist it as `lastConfirmedByteOffset` WITHOUT
   * ever calling `opfsRun.commit()` first — `FileSystemWritableFileStream.write()` only buffers into
   * a swap file, so none of those bytes were actually visible/durable yet, and `tryResumeOpfsRun`'s
   * "is the file at least this big?" check failed 100% of the time (see utils/opfs-store.ts's
   * `commit()` doc comment for the full explanation). `commit()` must complete BEFORE the checkpoint
   * is persisted — a failed commit (thrown, caught here) means this round genuinely didn't happen,
   * so it must not save a checkpoint claiming otherwise; it just tries again at the next interval.
   */
  async function maybeSaveCheckpoint(): Promise<void> {
    const now = Date.now();
    if (now - lastCheckpointAt < CHECKPOINT_INTERVAL_MS) return;
    lastCheckpointAt = now;
    try {
      await opfsRun.commit();
    } catch (err) {
      debugLog(jobId, 'checkpoint commit() failed — skipping this checkpoint round, will retry next interval', { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const saved = buildCheckpoint({
      jobId,
      manifestUrl: checkpoint.manifestUrl,
      opfsRunId: checkpoint.opfsRunId,
      segmentsDone: control.segmentsDone,
      lastConfirmedByteOffset: opfsRun.bytesWritten(),
      total,
      resolutionLabel: checkpoint.resolutionLabel,
    });
    debugLog(jobId, `saving checkpoint — lastConfirmedSegmentIndex=${saved.lastConfirmedSegmentIndex}, byteOffset=${saved.lastConfirmedByteOffset}`);
    pendingCheckpointSave = persistCheckpoint(saved);
  }

  /**
   * Bugfix (docs/ROADMAP.md §8.10): `inFlight` used to be tracked per FETCH ATTEMPT, decremented the
   * instant the fetch settled — but a successful fetch's bytes still have to pass through the
   * ordering buffer and this write chain before its `'segments'` progress event actually goes out.
   * That write is fully asynchronous and NOT bounded by `inFlight`, so the sequence could be: last
   * in-flight fetch settles → `inFlight` hits 0 while a PAUSE is pending → engine emits `'paused'` →
   * THEN the queued write for that same segment finishes and emits `'segments'` right after,
   * silently overwriting `'paused'` back to an active phase. From the UI this looked exactly like
   * the report: Pause never actually flips the button to Resume. `inFlight` now spans the WHOLE
   * claimed-segment lifecycle (fetch — including retries — AND its eventual write), incremented once
   * per worker claim and decremented exactly once either here (write path) or in the worker's catch
   * (failure path) — never per attempt — so there is no gap where the counter can read 0 before
   * every side effect of a claimed segment has actually happened.
   */
  function enqueueWrite(index: number, bytes: ArrayBuffer): void {
    writeChain = writeChain.then(async () => {
      await opfsRun.write(new Uint8Array(bytes));
      debugLog(jobId, `segment ${index + 1}/${total} written to OPFS`);
      control.segmentsDone = index + 1;
      const elapsedMs = Date.now() - control.startedAt;
      emit(jobId, 'segments', {
        segmentsDone: control.segmentsDone,
        segmentsTotal: total,
        bytesPerSec: throughputBytesPerSec(control.bytesDownloaded, elapsedMs),
        etaMs: estimateEtaMs(control.segmentsDone, total, elapsedMs),
      });
      noteFetchSettled(jobId, control);
      // Awaited (not fire-and-forget) — `maybeSaveCheckpoint`'s `opfsRun.commit()` closes and
      // reopens the writable, and the NEXT queued write on this same chain must not run until that
      // reopen has actually completed.
      await maybeSaveCheckpoint();
    });
  }

  return {
    submit(index, bytes) {
      for (const ready of ordered.add(index, bytes)) enqueueWrite(ready.index, ready.value);
    },
    drain() {
      return writeChain;
    },
    async drainQuietly() {
      await writeChain.catch(() => {});
    },
    async flushCheckpoints() {
      await pendingCheckpointSave.catch(() => {});
    },
  };
}
