import { drmRefusalMessage, evaluateResumeEligibility } from '../../../../../shared/download/checkpoint';
import { findRealDrmSegment } from '../../../../../shared/download/hls-crypto';
import type { DownloadEngineRelayedCommand, DownloadJobCheckpoint } from '../../../../../shared/download-engine-protocol';
import { parseM3u8, type ParsedManifest } from '../../../../../shared/media-manifest-parser';
import { tryResumeOpfsRun } from '../../../utils/opfs-store';
import { clearCheckpoint, createReplayHeaderApplier, type ReplayHeadersFor } from './background-relay.offscreen';
import { debugLog, emit } from './engine-events.offscreen';
import { cancelJob, createJobControl, isJobRunning, pauseJob, releaseJob, resumeJob, stopLiveJob } from './job-control.offscreen';
import { runLiveJob } from './live-job.offscreen';
import { startTurboJob } from './turbo-job.offscreen';
import { runVodJob } from './vod-job.offscreen';

/**
 * docs/ROADMAP.md §8.1/§11.2 — the download engine's entry point: command dispatch plus the two
 * manifest-driven job STARTS (fresh, and resume-from-checkpoint). Everything below the start guards
 * lives in its own module now (Phase 1's split of the old 1,355-line utils/download-engine.ts);
 * ui/offscreen/main.ts wires `handleEngineCommand` to incoming messages and does nothing else.
 *
 * Runs headless inside the singleton Offscreen Document — see engine-events.offscreen.ts for what
 * that costs (`chrome.runtime` only) and background-relay.offscreen.ts for how the rest is reached.
 *
 * Ported WITHOUT the old Merge Tab's tab-scoping dance: `syncHeaderReplayRule`'s `tabIds` param
 * already defaults to `[chrome.tabs.TAB_ID_NONE]` — the same scope the background service worker's
 * own fetches use — and an offscreen document's fetches are not tied to any tab either, so the old
 * `selfTabIds`/`sameTabIds` machinery (which existed only because a Tab's own fetches carry a real
 * tabId) was dropped entirely, not ported.
 */
export function handleEngineCommand(cmd: DownloadEngineRelayedCommand): void {
  debugLog(cmd.jobId, `received command '${cmd.op}'`, { url: cmd.url });
  switch (cmd.op) {
    case 'START':
      if (cmd.url) void startJob(cmd.jobId, cmd.url, cmd.resolutionLabel);
      break;
    case 'START_TURBO':
      if (cmd.url) void startTurboJob(cmd.jobId, cmd.url);
      break;
    case 'PAUSE':
      pauseJob(cmd.jobId);
      break;
    case 'RESUME':
      resumeJob(cmd.jobId);
      break;
    case 'CANCEL':
      cancelJob(cmd.jobId);
      break;
    case 'RESUME_CHECKPOINT':
      if (cmd.checkpoint) void resumeJobFromCheckpoint(cmd.checkpoint);
      break;
    case 'STOP_LIVE':
      stopLiveJob(cmd.jobId);
      break;
  }
}

interface ManifestFetchFailure {
  /** What the offscreen document's own console records — the two start paths fail for different
   * reasons and a repro is read straight off that console (see engine-events.offscreen.ts). */
  logLabel: string;
  /** Turns the underlying error's text into what the user sees. Bugfix: this used to be swallowed
   * completely — a genuine CORS/network failure reported a static, unrelated-sounding message with
   * NOTHING logged anywhere to explain what actually went wrong underneath. */
  userMessage: (detail: string) => string;
}

/** Fetch + parse in one step, shared by both start paths. Returns `undefined` after emitting the
 * error, so the caller just returns. */
async function fetchManifest(jobId: string, manifestUrl: string, replayHeadersFor: ReplayHeadersFor, failure: ManifestFetchFailure): Promise<ParsedManifest | undefined> {
  try {
    await replayHeadersFor(manifestUrl);
    const text = await (await fetch(manifestUrl)).text();
    return parseM3u8(text, manifestUrl);
  } catch (err) {
    console.error(`Synapse download engine: job ${jobId} ${failure.logLabel}`, err);
    emit(jobId, 'error', { message: failure.userMessage(err instanceof Error ? err.message : String(err)) });
    return undefined;
  }
}

async function startJob(jobId: string, manifestUrl: string, resolutionLabel?: string): Promise<void> {
  if (isJobRunning(jobId)) return; // already running — Side Panel already guards this, enforced again
  // here since Dashboard's smart-download can trigger the same id independently.
  const control = createJobControl(jobId, 'segments', false); // `live` is flipped once the manifest is fetched, below
  debugLog(jobId, `START — manifestUrl=${manifestUrl}`);
  try {
    const replayHeadersFor = await createReplayHeaderApplier(manifestUrl);
    const manifest = await fetchManifest(jobId, manifestUrl, replayHeadersFor, {
      logLabel: 'failed to fetch/parse the manifest',
      userMessage: (detail) => `Could not fetch this URL: ${manifestUrl} (${detail})`,
    });
    if (!manifest) return;

    debugLog(jobId, `manifest fetched — kind='${manifest.kind}'`, manifest.kind === 'media' ? { segments: manifest.segments.length, isLive: manifest.isLive } : undefined);

    if (manifest.kind === 'unknown') {
      emit(jobId, 'error', { message: "This URL doesn't look like an HLS manifest (no #EXTINF or #EXT-X-STREAM-INF found in it)." });
      return;
    }
    if (manifest.kind === 'master') {
      emit(jobId, 'error', {
        message:
          "This is a master playlist listing multiple resolutions, not a single downloadable stream. Pick a specific resolution from this video's list in the Side Panel or Dashboard instead.",
      });
      return;
    }

    // Mandatory guard, not optional (docs/ROADMAP.md §5.3/§8.4) — feeding a real-DRM segment into
    // ffmpeg.wasm's `-c copy` doesn't fail loudly, it produces a silently-corrupt file. Plain
    // AES-128 (identity KEYFORMAT) is NOT blocked here — the segment fetcher decrypts it
    // transparently.
    const drmKey = findRealDrmSegment(manifest.segments);
    if (drmKey) {
      emit(jobId, 'error', { message: drmRefusalMessage(drmKey) });
      return;
    }

    control.live = manifest.isLive;
    if (manifest.isLive) {
      await runLiveJob(jobId, control, manifest, manifestUrl, replayHeadersFor);
    } else {
      await runVodJob(jobId, control, manifest, manifestUrl, replayHeadersFor, { resolutionLabel });
    }
  } catch (err) {
    // Bugfix: nothing in the engine used to `console.error` a genuine job failure — only the 401/403
    // diagnostic and a remux fallback ever logged anything, so a plain network/HTTP failure reached
    // the Side Panel's "Failed: ..." text with NOTHING in the offscreen document's own console
    // (chrome://extensions' "Inspect views") to explain why. Log the full error object (not just its
    // message) here so it's actually diagnosable next time.
    console.error(`Synapse download engine: job ${jobId} failed`, err);
    emit(jobId, 'error', { message: err instanceof Error ? err.message : String(err) });
  } finally {
    releaseJob(jobId);
  }
}

/**
 * docs/ROADMAP.md §8.12 — continues an HLS job that got no chance to reach any terminal state
 * before this Offscreen Document (and everything it was doing) died — a real browser crash/close,
 * or a manual extension reload while a download was in flight. Every early-return path here clears
 * the checkpoint AND reports an error explaining why resume wasn't possible, so the user isn't left
 * staring at a "Resume" row that will never work again; a fresh Download from scratch is always the
 * fallback the message points at.
 *
 * Deliberately re-derives almost everything from scratch rather than trusting the checkpoint's own
 * numbers: the manifest is refetched+reparsed (docs/ROADMAP.md §7.4's existing machinery, since a
 * signed segment URL list can rot between sessions exactly like a mid-run refresh), and the OPFS
 * file's real `size` is what decides whether `lastConfirmedByteOffset` can be trusted at all
 * (utils/opfs-store.ts's `tryResumeOpfsRun`) — the checkpoint is a HINT for where to resume, never a
 * fact taken on faith. Which refusals apply, and their wording, is `evaluateResumeEligibility`'s
 * (pure, tested) decision.
 */
async function resumeJobFromCheckpoint(checkpoint: DownloadJobCheckpoint): Promise<void> {
  const { jobId } = checkpoint;
  if (isJobRunning(jobId)) return; // already running (e.g. a duplicate click) — same guard as startJob
  const control = createJobControl(jobId, 'segments', false); // §8.12 explicitly refuses to resume a checkpoint whose manifest has since gone live
  debugLog(jobId, `RESUME_CHECKPOINT — opfsRunId=${checkpoint.opfsRunId}, resuming from segment index ${checkpoint.lastConfirmedSegmentIndex + 1}/${checkpoint.total}`);
  try {
    const replayHeadersFor = await createReplayHeaderApplier(checkpoint.manifestUrl);
    const manifest = await fetchManifest(jobId, checkpoint.manifestUrl, replayHeadersFor, {
      logLabel: 'failed to refetch the manifest to resume',
      userMessage: (detail) => `Could not refetch the manifest to resume: ${detail}. Start a fresh download instead.`,
    });
    if (!manifest) return;

    const eligibility = evaluateResumeEligibility(manifest, checkpoint);
    if (!eligibility.ok) {
      emit(jobId, 'error', { message: eligibility.message });
      return;
    }

    const opfsRun = await tryResumeOpfsRun(checkpoint.opfsRunId, checkpoint.lastConfirmedByteOffset);
    if (!opfsRun) {
      emit(jobId, 'error', { message: "The partially-downloaded file is missing (or smaller than expected) — can't resume safely. Start a fresh download instead." });
      return;
    }

    await runVodJob(jobId, control, eligibility.manifest, checkpoint.manifestUrl, replayHeadersFor, {
      resolutionLabel: checkpoint.resolutionLabel,
      resume: { runId: checkpoint.opfsRunId, opfsRun, startIndex: eligibility.startIndex },
    });
  } catch (err) {
    console.error(`Synapse download engine: job ${jobId} failed to resume`, err);
    emit(jobId, 'error', { message: err instanceof Error ? err.message : String(err) });
  } finally {
    releaseJob(jobId);
    // Every early-return above (and runVodJob's own `finally`, on the success path) needs the
    // checkpoint gone either way — cheap to also clear it here so no early-return branch above can
    // forget it individually. Idempotent no-op if runVodJob already cleared it.
    void clearCheckpoint(jobId);
  }
}
