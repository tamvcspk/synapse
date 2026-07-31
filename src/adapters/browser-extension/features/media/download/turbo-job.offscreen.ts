import { parseContentRangeTotal, planRangeChunks, rangeHeader } from '../../../../../shared/download/byte-ranges';
import { fileNameFromUrl } from '../../../../../shared/download/output-naming';
import { estimateEtaMs, throughputBytesPerSec } from '../../../../../shared/download/progress';
import { MAX_FETCH_ATTEMPTS, backoffDelayMs, hasAttemptsLeft } from '../../../../../shared/download/retry';
import { createOpfsRun, removeOpfsRun } from '../../../utils/opfs-store';
import { createReplayHeaderApplier, type ReplayHeadersFor } from './background-relay.offscreen';
import { debugLog, emit } from './engine-events.offscreen';
import { awaitResumeOrCancel, createJobControl, isJobRunning, noteFetchSettled, releaseJob } from './job-control.offscreen';
import { downloadFile } from './output.offscreen';

/**
 * docs/ROADMAP.md §8.2/§11.2 — opt-in "Turbo download": a multi-connection Range downloader for a
 * plain static `video`/`audio` file, used only when the Side Panel's Turbo toggle is on (default
 * off). Split out of utils/download-engine.ts (Phase 1). Unlike the HLS jobs there's no manifest, no
 * decryption, no remux — the output is exactly the source bytes, so the only job here is fetching N
 * byte-ranges in parallel and landing each one at its own OPFS offset the instant it arrives.
 *
 * Deliberately NOT checkpointed (§8.12): a handful of huge chunks has no natural small
 * "already durably written" boundary worth persisting.
 */

const TURBO_CHUNK_COUNT = 6; // within the roadmap's stated 4–8 pool size
const MIN_TURBO_SIZE_BYTES = 5 * 1024 * 1024; // below this, N-connection overhead isn't worth it

interface RangeProbeResult {
  contentLength: number;
}

/**
 * docs/ROADMAP.md §8.2 — `HEAD` first (checks both `Content-Length` and `Accept-Ranges: bytes`).
 * Broadened slightly from the roadmap's literal wording: the `GET Range: bytes=0-0` fallback fires
 * whenever HEAD didn't CONCLUSIVELY confirm range support (missing/wrong `Accept-Ranges` on an
 * otherwise-200 response also triggers it), not only on a HEAD 405 — plenty of real servers support
 * ranges without advertising the header, and the fallback probe is cheap regardless of why HEAD came
 * up short. Returns `undefined` on any failure to confirm — caller falls back to `chrome.downloads`.
 */
async function probeRangeSupport(url: string, replayHeadersFor: ReplayHeadersFor): Promise<RangeProbeResult | undefined> {
  await replayHeadersFor(url);
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (head.ok) {
      const length = Number(head.headers.get('Content-Length'));
      if (head.headers.get('Accept-Ranges') === 'bytes' && Number.isFinite(length) && length > 0) {
        return { contentLength: length };
      }
    }
  } catch {
    // Fall through to the ranged-GET probe below.
  }
  try {
    const res = await fetch(url, { headers: { Range: rangeHeader(0, 0) } });
    await res.arrayBuffer().catch(() => {}); // drain the tiny 1-byte body
    if (res.status !== 206) return undefined;
    const total = parseContentRangeTotal(res.headers.get('Content-Range'));
    return total === undefined ? undefined : { contentLength: total };
  } catch {
    return undefined;
  }
}

export async function startTurboJob(jobId: string, url: string): Promise<void> {
  if (isJobRunning(jobId)) return; // already running
  const control = createJobControl(jobId, 'chunks', false); // turbo is a plain Range downloader, never manifest-driven — never live
  debugLog(jobId, `START_TURBO — url=${url}`);
  try {
    const replayHeadersFor = await createReplayHeaderApplier(url);
    const probe = await probeRangeSupport(url, replayHeadersFor);
    debugLog(jobId, 'range probe result', probe ? { contentLength: probe.contentLength } : { supported: false });

    if (control.cancelled) {
      emit(jobId, 'cancelled');
      return;
    }

    // docs/ROADMAP.md §8.2 — "Không xác nhận được → im lặng dùng chrome.downloads." Same silent
    // fallback for a file too small for N-connection overhead to be worth it (not in the original
    // spec text, but the reasoning is identical).
    if (!probe || probe.contentLength < MIN_TURBO_SIZE_BYTES) {
      debugLog(jobId, 'falling back to chrome.downloads.download (no/weak range support, or file too small)');
      chrome.downloads.download({ url });
      emit(jobId, 'done', { message: 'Downloaded directly — this server or file is not a good fit for Turbo download.' });
      return;
    }

    const chunks = planRangeChunks(probe.contentLength, TURBO_CHUNK_COUNT);
    const chunkCount = chunks.length;
    control.segmentsTotal = chunkCount;
    debugLog(jobId, `${chunkCount} chunk(s), total ${probe.contentLength} bytes`);

    const runId = crypto.randomUUID();
    const opfsRun = await createOpfsRun(runId);
    let writeChain: Promise<void> = Promise.resolve();
    let doneCount = 0;

    /**
     * One large ranged GET per chunk, retried with backoff like the HLS segment fetcher — same
     * per-attempt `AbortController` (registered on `control.abortControllers`) so CANCEL interrupts
     * immediately even mid-transfer through a chunk that could be hundreds of MB.
     */
    async function fetchChunk(chunkIndex: number, start: number, end: number): Promise<void> {
      let lastError: unknown;
      for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt++) {
        // boundary-only pause — see JobControl's doc comment
        if (await awaitResumeOrCancel(control)) return;
        const controller = new AbortController();
        control.abortControllers.add(controller);
        control.inFlight++;
        try {
          debugLog(jobId, `chunk ${chunkIndex + 1}/${chunkCount} attempt ${attempt + 1}/${MAX_FETCH_ATTEMPTS} — fetching ${rangeHeader(start, end)}`);
          await replayHeadersFor(url);
          const res = await fetch(url, { headers: { Range: rangeHeader(start, end) }, signal: controller.signal });
          debugLog(jobId, `chunk ${chunkIndex + 1}/${chunkCount} attempt ${attempt + 1}/${MAX_FETCH_ATTEMPTS} — HTTP ${res.status}`);
          if (res.status !== 206 && res.status !== 200) throw new Error(`Part ${chunkIndex + 1} failed: HTTP ${res.status}`);
          const bytes = new Uint8Array(await res.arrayBuffer());
          control.bytesDownloaded += bytes.byteLength;
          writeChain = writeChain.then(() => opfsRun.write(bytes, start));
          await writeChain;
          debugLog(jobId, `chunk ${chunkIndex + 1}/${chunkCount} written to OPFS`);
          doneCount++;
          control.segmentsDone = doneCount;
          const elapsedMs = Date.now() - control.startedAt;
          emit(jobId, 'chunks', {
            segmentsDone: doneCount,
            segmentsTotal: chunkCount,
            bytesPerSec: throughputBytesPerSec(control.bytesDownloaded, elapsedMs),
            etaMs: estimateEtaMs(doneCount, chunkCount, elapsedMs),
          });
          return;
        } catch (err) {
          lastError = err;
          debugLog(jobId, `chunk ${chunkIndex + 1}/${chunkCount} attempt ${attempt + 1}/${MAX_FETCH_ATTEMPTS} — threw`, { error: err instanceof Error ? err.message : String(err) });
        } finally {
          control.abortControllers.delete(controller);
          // Tracked per ATTEMPT (not per chunk) on purpose: the backoff sleep AND the pause-boundary
          // wait both happen between attempts, outside this try/finally, so a chunk that's between
          // retries or waiting on a RESUME isn't actually using the network right now and must not
          // hold up a PAUSE from settling into `'paused'` (see `noteFetchSettled`).
          noteFetchSettled(jobId, control);
        }
        if (control.cancelled) return; // CANCEL's abort() lands here as a caught error — don't retry it
        if (hasAttemptsLeft(attempt)) await new Promise((r) => setTimeout(r, backoffDelayMs(attempt)));
      }
      debugLog(jobId, `chunk ${chunkIndex + 1}/${chunkCount} — exhausted all ${MAX_FETCH_ATTEMPTS} attempts, giving up`);
      // Same fail-fast handshake as the VOD pool's worker: mark the job cancelled BEFORE throwing so
      // every other in-flight chunk's next attempt-loop check sees it and stops claiming further
      // retries, then let `Promise.all` below propagate this rejection straight to the outer
      // `catch` — never through the `if (control.cancelled)` branch, which stays reachable only by a
      // true CANCEL command (every chunk returning normally, none throwing).
      control.cancelled = true;
      throw lastError instanceof Error ? lastError : new Error(`Part ${chunkIndex + 1} failed after ${MAX_FETCH_ATTEMPTS} attempts.`);
    }

    try {
      await Promise.all(chunks.map((chunk) => fetchChunk(chunk.index, chunk.start, chunk.end)));
      debugLog(jobId, `all chunks returned — cancelled=${control.cancelled}`);

      // Reached only when every chunk RETURNED (not threw) — i.e. a true CANCEL, not a real failure
      // (a real failure sets `cancelled` too, but THROWS, which `Promise.all` propagates straight to
      // the `catch` below instead of here — same distinction the VOD job relies on).
      if (control.cancelled) {
        await opfsRun.abort();
        emit(jobId, 'cancelled');
        return;
      }

      const file = await opfsRun.finish();
      debugLog(jobId, `OPFS run finished, ${file.size} bytes — handing to chrome.downloads`);
      downloadFile(file, fileNameFromUrl(url) || `download-${jobId}`);
      emit(jobId, 'done');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Synapse download engine: turbo job ${jobId} failed`, err);
      await opfsRun.abort();
      emit(jobId, 'error', { message });
    } finally {
      void removeOpfsRun(runId).catch(() => {});
    }
  } catch (err) {
    console.error(`Synapse download engine: turbo job ${jobId} failed`, err);
    emit(jobId, 'error', { message: err instanceof Error ? err.message : String(err) });
  } finally {
    releaseJob(jobId);
  }
}
