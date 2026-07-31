import { segmentsForIndexRemap } from '../../../../../shared/download/hls-segments';
import { parseM3u8, type ManifestSegment, type ParsedManifest } from '../../../../../shared/media-manifest-parser';
import { createOpfsRun, removeOpfsRun, type OpfsRun } from '../../../utils/opfs-store';
import { clearCheckpoint, createAuthDiagnostics, type ReplayHeadersFor } from './background-relay.offscreen';
import { debugLog, emit } from './engine-events.offscreen';
import { awaitResumeOrCancel, noteFetchSettled, type JobControl } from './job-control.offscreen';
import { produceOutput } from './output.offscreen';
import { fetchAndDecryptSegment, fetchInitSegmentBytes } from './segment-fetcher.offscreen';
import { createSegmentPipeline } from './segment-pipeline.offscreen';

/**
 * docs/ROADMAP.md §8.1/§8.3/§11.2 — the VOD (fixed segment set) job kind: a pool of concurrent
 * segment fetches feeding one ordered write pipeline. Split out of utils/download-engine.ts
 * (Phase 1); the write side now lives in segment-pipeline.offscreen.ts and the lifecycle state in
 * job-control.offscreen.ts, leaving this file as the pool itself plus §7.4's expired-URL recovery.
 */

const SEGMENT_POOL_SIZE = 5;

/** docs/ROADMAP.md §8.12 — present only when continuing a previously-interrupted job
 * (`resumeJobFromCheckpoint`) rather than starting a fresh one. */
export interface VodResumeState {
  runId: string;
  opfsRun: OpfsRun;
  /** 0-based index to start fetching/writing from — everything before it is already durably on
   * disk in `opfsRun`'s file (verified against its real size before this is ever constructed). */
  startIndex: number;
}

export interface VodJobOptions {
  resolutionLabel?: string | undefined;
  resume?: VodResumeState | undefined;
}

/**
 * docs/ROADMAP.md §7.4 — a segment 401/403/404/410 mid-run usually means its signed URL expired or
 * the sliding window moved on, not that the video vanished: refetching the SAME manifest almost
 * always reissues the whole segment list with fresh signatures. The caller replaces its working
 * `segments` array WHOLESALE, by INDEX — safe under the concurrent pool because already-fetched-
 * and-written indices are never re-read, only not-yet-fetched ones observe the replacement. Whether
 * the refetched manifest may be used at all is `segmentsForIndexRemap`'s (pure, tested) decision.
 */
async function refetchSegments(manifestUrl: string, fromIndex: number, replayHeadersFor: ReplayHeadersFor): Promise<ManifestSegment[] | undefined> {
  try {
    await replayHeadersFor(manifestUrl);
    const text = await (await fetch(manifestUrl)).text();
    return segmentsForIndexRemap(parseM3u8(text, manifestUrl), fromIndex);
  } catch {
    return undefined;
  }
}

export async function runVodJob(
  jobId: string,
  control: JobControl,
  manifest: Extract<ParsedManifest, { kind: 'media' }>,
  sourceUrl: string,
  replayHeadersFor: ReplayHeadersFor,
  options: VodJobOptions = {},
): Promise<void> {
  const runId = options.resume?.runId ?? crypto.randomUUID();
  const opfsRun = options.resume?.opfsRun ?? (await createOpfsRun(runId));
  const total = manifest.segments.length;
  const startIndex = options.resume?.startIndex ?? 0;
  control.segmentsTotal = total;
  control.segmentsDone = startIndex; // §8.12 resume: everything before this index is already on disk
  debugLog(
    jobId,
    `runVodJob ${options.resume ? 'RESUMING' : 'starting'} — runId=${runId}, ${total} segment(s) total${options.resume ? `, starting at index ${startIndex}` : ''}, pool=${Math.min(SEGMENT_POOL_SIZE, total - startIndex)}`,
  );

  // docs/ROADMAP.md §7.4 — replaced WHOLESALE (not spliced by index) once a rotating-signature CDN
  // reissues the manifest; safe under the concurrent pool because only not-yet-fetched indices ever
  // read `segments` again.
  let segments = manifest.segments;
  let refreshBudgetSpent = false;

  async function ensureRefreshed(triggeringIndex: number): Promise<boolean> {
    if (refreshBudgetSpent || manifest.isLive) return false;
    refreshBudgetSpent = true;
    const refreshed = await refetchSegments(sourceUrl, triggeringIndex, replayHeadersFor);
    if (!refreshed) return false;
    segments = refreshed;
    return true;
  }

  const reportAuthFailure = createAuthDiagnostics(sourceUrl, 'segment');

  const pipeline = createSegmentPipeline({
    jobId,
    control,
    opfsRun,
    total,
    startIndex,
    checkpoint: { manifestUrl: sourceUrl, opfsRunId: runId, resolutionLabel: options.resolutionLabel },
  });

  let nextToFetch = startIndex;

  async function worker(): Promise<void> {
    for (;;) {
      // docs/ROADMAP.md §8.1 — pauses at a segment boundary: an in-flight fetch (claimed before
      // PAUSE arrived) is allowed to finish, only the NEXT claim blocks here.
      if (await awaitResumeOrCancel(control)) return;
      const index = nextToFetch++;
      if (index >= total) return;
      control.inFlight++; // spans fetch (incl. retries) through this segment's eventual write — see createSegmentPipeline's doc comment
      let bytes: ArrayBuffer;
      try {
        bytes = await fetchAndDecryptSegment(() => segments[index]!, manifest.mediaSequence + index, `Segment ${index + 1}/${total}`, {
          jobId,
          control,
          replayHeadersFor,
          onAuthFailure: reportAuthFailure,
          tryRecoverExpiredUrl: () => ensureRefreshed(index),
        });
      } catch (err) {
        noteFetchSettled(jobId, control); // no write will happen for this segment — settle here instead
        // A CANCEL-triggered abort throws too (the fetcher's own AbortController), but
        // `control.cancelled` is already true by the time it does — `cancelJob` sets it
        // synchronously before calling `.abort()`. That's a true cancellation, not a real failure,
        // so this worker must RETURN (not throw): the `if (control.cancelled)` check after
        // `Promise.all` only sees a clean cancel when EVERY worker returns normally — a rethrow here
        // would route it through the `catch` below instead and misreport it as an error.
        if (control.cancelled) {
          debugLog(jobId, `segment ${index + 1}/${total} — worker returning cleanly (cancelled)`);
          return;
        }
        debugLog(jobId, `segment ${index + 1}/${total} — real failure, aborting whole job`, { error: err instanceof Error ? err.message : String(err) });
        control.cancelled = true;
        throw err;
      }
      if (control.cancelled) {
        // Fetched successfully but CANCEL landed in the meantime (e.g. another worker's segment
        // failed for real) — this segment is being discarded without ever reaching the pipeline, so
        // its `inFlight++` above must still be balanced here, or it leaks forever.
        noteFetchSettled(jobId, control);
        return;
      }
      pipeline.submit(index, bytes);
    }
  }

  try {
    // §8.12 resume: the init segment (if any) is always the very first bytes written, before any
    // worker starts — by the time a checkpoint exists to resume FROM, it must already be on disk.
    if (manifest.initSegment && !options.resume) {
      debugLog(jobId, 'fetching init segment (#EXT-X-MAP)');
      const initBytes = await fetchInitSegmentBytes(manifest.initSegment, manifest.mediaSequence, replayHeadersFor, reportAuthFailure);
      await opfsRun.write(new Uint8Array(initBytes));
      debugLog(jobId, 'init segment written');
    }

    const workerCount = Math.min(SEGMENT_POOL_SIZE, Math.max(total - startIndex, 0));
    debugLog(jobId, `spinning up ${workerCount} worker(s)`);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    debugLog(jobId, `all workers returned — cancelled=${control.cancelled}`);

    // Reached only when every worker RETURNED (not threw) — either every segment succeeded, or a
    // CANCEL fired and every worker exited early via the `cancelled` checks above with no error.
    if (control.cancelled) {
      await pipeline.drainQuietly();
      await opfsRun.abort();
      emit(jobId, 'cancelled');
      return;
    }

    await pipeline.drain();
    debugLog(jobId, 'writes drained — finishing OPFS run and producing output');
    const file = await opfsRun.finish();
    // An init segment is what distinguishes fMP4 from MPEG-TS, so it also decides the container the
    // concatenated bytes already are.
    await produceOutput(jobId, file, sourceUrl, manifest.initSegment ? 'mp4' : 'ts');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Synapse download engine: job ${jobId} failed`, err);
    await pipeline.drainQuietly();
    await opfsRun.abort();
    emit(jobId, 'error', { message });
  } finally {
    // docs/ROADMAP.md §8.12 — cleared on EVERY terminal outcome (done/error/cancelled), not just
    // success: a checkpoint only exists to survive an INTERRUPTION (crash/reload) the job never got
    // a chance to react to. A real in-session error still means "start over" (same philosophy as
    // the fetcher's own exhausted-retries path) — it does not leave a resumable checkpoint behind.
    // Awaiting the last in-flight save first guarantees this clear is the LAST checkpoint-related
    // message background sees for this jobId.
    await pipeline.flushCheckpoints();
    void clearCheckpoint(jobId);
    void removeOpfsRun(runId).catch(() => {});
  }
}
