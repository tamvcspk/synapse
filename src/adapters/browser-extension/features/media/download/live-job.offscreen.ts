import { describeDrmKey, isRealDrm } from '../../../../../shared/download/hls-crypto';
import { livePollDelayMs, selectPendingLiveSegments } from '../../../../../shared/download/hls-segments';
import { throughputBytesPerSec } from '../../../../../shared/download/progress';
import { parseM3u8, type ParsedManifest } from '../../../../../shared/media-manifest-parser';
import { createOpfsRun } from '../../../utils/opfs-store';
import { createAuthDiagnostics, type ReplayHeadersFor } from './background-relay.offscreen';
import { debugLog, emit } from './engine-events.offscreen';
import { awaitResumeOrCancel, noteFetchSettled, type JobControl } from './job-control.offscreen';
import { produceOutput } from './output.offscreen';
import { fetchAndDecryptSegment, fetchInitSegmentBytes } from './segment-fetcher.offscreen';

/**
 * docs/ROADMAP.md §10.1/§11.2 — the live/continuous capture job kind. A live/sliding-window HLS
 * manifest has no fixed segment set, so this is NOT the VOD job with a bigger `total`: it's a
 * sequential poll-fetch-write loop, not a pool. New segments show up one at a time at roughly
 * `targetDurationSec` cadence, so there's no backlog to parallelize the way VOD's
 * `SEGMENT_POOL_SIZE` workers do — sequential fetch also means writes land in order for free, with
 * no ordering buffer needed (which is why this file uses `opfsRun` directly rather than
 * segment-pipeline.offscreen.ts).
 *
 * Segment identity across polls is tracked by ABSOLUTE HLS media-sequence number, not array index —
 * a live playlist's window slides, so index `i` doesn't name the same segment across two fetches
 * (docs/ROADMAP.md §7.4's existing rationale for refusing wholesale index-remap on live). That
 * selection rule is pure and unit-tested in `shared/download/hls-segments.ts`.
 *
 * Ends one of three ways: `control.cancelled` (user Cancel — discard, same as VOD); the manifest
 * gains `#EXT-X-ENDLIST` (stream ended naturally); or `control.liveStopRequested` (user clicked
 * Stop, §10.1's `STOP_LIVE` command) — the latter two both drain whatever's already queued from the
 * most recent poll, then fall through to the SAME finish path as VOD (`opfsRun.finish()` →
 * `produceOutput()`, one remux at the very end, same size-cap fallback).
 *
 * Deliberately does NOT checkpoint (no `persistCheckpoint`/`opfsRun.commit()` calls) — see
 * docs/ROADMAP.md §10.1: `commit()` is O(current file size) and this file has no final size, and a
 * live capture interrupted by an Offscreen Document restart is simply lost (same as Cancel),
 * matching the codebase's existing explicit refusal to resume a stream that has since gone live.
 */

const MAX_CONSECUTIVE_LIVE_POLL_FAILURES = 5;

export async function runLiveJob(
  jobId: string,
  control: JobControl,
  initialManifest: Extract<ParsedManifest, { kind: 'media' }>,
  sourceUrl: string,
  replayHeadersFor: ReplayHeadersFor,
): Promise<void> {
  const runId = crypto.randomUUID();
  const opfsRun = await createOpfsRun(runId);
  let manifest = initialManifest;
  let nextSequenceToFetch = initialManifest.mediaSequence;
  const reportAuthFailure = createAuthDiagnostics(sourceUrl, 'live segment');

  debugLog(jobId, `runLiveJob starting — runId=${runId}, initial mediaSequence=${initialManifest.mediaSequence}`);

  try {
    if (manifest.initSegment) {
      debugLog(jobId, 'fetching init segment (#EXT-X-MAP)');
      const initBytes = await fetchInitSegmentBytes(manifest.initSegment, initialManifest.mediaSequence, replayHeadersFor, reportAuthFailure);
      await opfsRun.write(new Uint8Array(initBytes));
      debugLog(jobId, 'init segment written');
    }

    let consecutivePollFailures = 0;

    pollLoop: for (;;) {
      if (control.cancelled) break;

      // Everything the CURRENT poll lists that hasn't been captured yet, oldest first.
      for (const { sequence, segment } of selectPendingLiveSegments(manifest, nextSequenceToFetch)) {
        if (await awaitResumeOrCancel(control)) break pollLoop;

        // Same mandatory guard as the start check (docs/ROADMAP.md §5.3/§8.4) — a live source could
        // start using real DRM mid-capture even if the first poll didn't show any.
        if (segment.key && isRealDrm(segment.key)) {
          throw new Error(`This stream became DRM-protected mid-capture (${describeDrmKey(segment.key)}) — stopping.`);
        }

        control.inFlight++;
        try {
          const bytes = await fetchAndDecryptSegment(() => segment, sequence, `Live segment #${sequence}`, {
            jobId,
            control,
            replayHeadersFor,
            onAuthFailure: reportAuthFailure,
          });
          await opfsRun.write(new Uint8Array(bytes));
          nextSequenceToFetch = sequence + 1;
          control.segmentsDone = nextSequenceToFetch - initialManifest.mediaSequence;
          debugLog(jobId, `live segment #${sequence} written to OPFS`);
          emit(jobId, 'segments', {
            segmentsDone: control.segmentsDone,
            bytesPerSec: throughputBytesPerSec(control.bytesDownloaded, Date.now() - control.startedAt),
            live: true,
          });
        } catch (err) {
          if (control.cancelled) break pollLoop;
          // One dropped segment shouldn't kill an hours-long capture — log and move past it.
          console.warn(`Synapse: live capture ${jobId} skipping segment #${sequence} after exhausted retries`, err);
          nextSequenceToFetch = sequence + 1;
        } finally {
          noteFetchSettled(jobId, control);
        }
      }

      if (control.cancelled) break;
      if (!manifest.isLive) control.liveStopRequested = true; // #EXT-X-ENDLIST showed up
      if (control.liveStopRequested) break;

      const waitMs = livePollDelayMs(manifest.targetDurationSec);
      debugLog(jobId, `live poll — waiting ${waitMs}ms before refetching manifest`);
      await new Promise((r) => setTimeout(r, waitMs));
      if (await awaitResumeOrCancel(control)) break;
      if (control.liveStopRequested) break; // STOP_LIVE may have arrived during the wait/pause above

      try {
        await replayHeadersFor(sourceUrl);
        const text = await (await fetch(sourceUrl)).text();
        const reparsed = parseM3u8(text, sourceUrl);
        if (reparsed.kind !== 'media') throw new Error('This URL no longer looks like a media playlist.');
        manifest = reparsed;
        consecutivePollFailures = 0;
      } catch (err) {
        consecutivePollFailures++;
        debugLog(jobId, `live manifest poll failed (${consecutivePollFailures}/${MAX_CONSECUTIVE_LIVE_POLL_FAILURES})`, { error: err instanceof Error ? err.message : String(err) });
        if (consecutivePollFailures >= MAX_CONSECUTIVE_LIVE_POLL_FAILURES) {
          throw new Error(`Could not refetch the live manifest after ${MAX_CONSECUTIVE_LIVE_POLL_FAILURES} attempts: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (control.cancelled) {
      await opfsRun.abort();
      emit(jobId, 'cancelled');
      return;
    }

    debugLog(jobId, 'live capture stopped — finishing OPFS run and producing output');
    const file = await opfsRun.finish();
    await produceOutput(jobId, file, sourceUrl, initialManifest.initSegment ? 'mp4' : 'ts');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Synapse download engine: live job ${jobId} failed`, err);
    await opfsRun.abort();
    emit(jobId, 'error', { message });
  }
}
