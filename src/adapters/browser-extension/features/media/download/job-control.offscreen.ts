import { debugLog, emit } from './engine-events.offscreen';

/**
 * docs/ROADMAP.md §8.1/§8.10/§10.1/§11.2 — the lifecycle state ONE download job carries, plus the
 * PAUSE/RESUME/CANCEL/STOP_LIVE commands that act on it. Split out of utils/download-engine.ts
 * (Phase 1: "runJob → SegmentPipeline + JobControl + output") because all three job kinds
 * (VOD pool, live loop, turbo range) share this state machine verbatim and none of them owns it.
 *
 * Multi-job by necessity, not by choice: MV3 allows exactly ONE offscreen document per extension,
 * so the registry below is a shared map rather than one instance per download. `jobId` is always
 * `DetectedMedia.id` (docs/ROADMAP.md §7.6's existing convention).
 */

export interface JobControl {
  cancelled: boolean;
  pausedPromise: Promise<void> | null;
  resolvePause: (() => void) | null;
  segmentsDone: number;
  segmentsTotal: number;
  bytesDownloaded: number;
  startedAt: number;
  /** Registered by BOTH job kinds (HLS's segment fetch, turbo's chunk fetch) — one entry per
   * currently-in-flight `fetch()`, aborted outright by `cancelJob` so CANCEL takes effect
   * immediately instead of waiting for whatever's already downloading to finish naturally. */
  abortControllers: Set<AbortController>;
  /** How many segment/chunk fetch ATTEMPTS (the literal `fetch()` call, not the whole retry loop
   * around it) are happening right now — used only to know when a requested PAUSE has actually taken
   * effect. See `pauseJob`/`noteFetchSettled`. */
  inFlight: number;
  /** Which phase a RESUME should re-emit — the UI renders `'segments'`/`'chunks'` identically, this
   * just keeps emitted events semantically accurate for whichever job kind this is. */
  kind: 'segments' | 'chunks';
  /** docs/ROADMAP.md §10.1 — set once at job creation. `pauseJob`/`resumeJob`/`noteFetchSettled` are
   * generic (not live-aware) and emit on behalf of any job kind, so this is threaded through their
   * events the same way `kind` already is — otherwise a pause/resume event for a live job would emit
   * with no `live` flag at all, which the Side Panel would read as "live-ness unknown" and silently
   * revert its live-specific rendering on every Pause click. */
  live: boolean;
  /** docs/ROADMAP.md §10.1 — set by the `STOP_LIVE` command or by the live poll loop itself seeing
   * `#EXT-X-ENDLIST`. Only ever read by the live job; VOD/turbo jobs never set it. */
  liveStopRequested?: boolean;
}

const jobs = new Map<string, JobControl>();

export function isJobRunning(jobId: string): boolean {
  return jobs.has(jobId);
}

/** Registers a fresh control block for `jobId`. The caller is responsible for `releaseJob` in a
 * `finally` — a job left in the registry blocks every future START for that same id. */
export function createJobControl(jobId: string, kind: JobControl['kind'], live: boolean): JobControl {
  const control: JobControl = {
    cancelled: false,
    pausedPromise: null,
    resolvePause: null,
    segmentsDone: 0,
    segmentsTotal: 0,
    bytesDownloaded: 0,
    startedAt: Date.now(),
    abortControllers: new Set(),
    inFlight: 0,
    kind,
    live,
  };
  jobs.set(jobId, control);
  return control;
}

export function releaseJob(jobId: string): void {
  jobs.delete(jobId);
}

/**
 * Bugfix (docs/ROADMAP.md §8.10): PAUSE used to emit `'paused'` immediately, but it only stops NEW
 * segment/chunk claims — up to one fetch per worker/chunk was typically still genuinely in flight
 * and would still complete (and still get written) a moment later, re-emitting `'segments'`/
 * `'chunks'` events right after. From the UI, that looked like the Pause button flipping to Resume
 * for an instant and then flipping right back, while segments kept visibly arriving after "Paused"
 * was already on screen. `'pausing'` is the honest intermediate state — `noteFetchSettled` promotes
 * it to `'paused'` once `inFlight` actually reaches zero. If nothing is in flight yet (PAUSE clicked
 * before any fetch started), it's genuinely paused right away.
 */
export function pauseJob(jobId: string): void {
  const control = jobs.get(jobId);
  if (!control) {
    debugLog(jobId, 'PAUSE ignored — no such job (already finished/settled?)');
    return;
  }
  if (control.pausedPromise) {
    debugLog(jobId, 'PAUSE ignored — already paused/pausing');
    return;
  }
  control.pausedPromise = new Promise((resolve) => {
    control.resolvePause = resolve;
  });
  debugLog(jobId, `PAUSE requested, inFlight=${control.inFlight}`);
  emit(jobId, control.inFlight > 0 ? 'pausing' : 'paused', { segmentsDone: control.segmentsDone, segmentsTotal: control.segmentsTotal, live: control.live });
}

export function resumeJob(jobId: string): void {
  const control = jobs.get(jobId);
  if (!control?.pausedPromise) {
    debugLog(jobId, 'RESUME ignored — not currently paused/pausing');
    return;
  }
  control.resolvePause?.();
  control.pausedPromise = null;
  control.resolvePause = null;
  debugLog(jobId, `RESUME — re-emitting '${control.kind}'`);
  emit(jobId, control.kind, { segmentsDone: control.segmentsDone, segmentsTotal: control.segmentsTotal, live: control.live });
}

/** Decrements `inFlight` once a segment/chunk fetch ATTEMPT settles (success or failure) and
 * promotes a pending PAUSE from `'pausing'` to `'paused'` the moment every such attempt has actually
 * stopped — called from both the HLS jobs and the turbo one. */
export function noteFetchSettled(jobId: string, control: JobControl): void {
  control.inFlight = Math.max(0, control.inFlight - 1);
  debugLog(jobId, `fetch attempt settled, inFlight now ${control.inFlight}`);
  if (control.pausedPromise && control.inFlight === 0) {
    debugLog(jobId, "inFlight reached 0 while pausing — promoting to 'paused'");
    emit(jobId, 'paused', { segmentsDone: control.segmentsDone, segmentsTotal: control.segmentsTotal, live: control.live });
  }
}

/** Also wakes a paused worker loop (resolves `pausedPromise`) so it observes `cancelled` on its next
 * check and exits, instead of hanging forever waiting for a RESUME that will never come. Aborts every
 * in-flight fetch (both job kinds register in `abortControllers`) so CANCEL takes effect immediately
 * instead of waiting for whatever's already downloading to finish naturally — the old "let HLS
 * segments finish naturally" behavior was the direct cause of a confusing overlap window where a
 * fresh Download click right after Cancel would silently no-op against the still-settling previous
 * job. */
export function cancelJob(jobId: string): void {
  const control = jobs.get(jobId);
  if (!control) {
    debugLog(jobId, 'CANCEL ignored — no such job (already finished/settled?)');
    return;
  }
  debugLog(jobId, `CANCEL requested — aborting ${control.abortControllers.size} in-flight fetch(es)`);
  control.cancelled = true;
  control.resolvePause?.();
  control.pausedPromise = null;
  control.resolvePause = null;
  for (const controller of control.abortControllers) controller.abort();
}

/** docs/ROADMAP.md §10.1 — a GRACEFUL finish for a live capture: drain whatever's already queued,
 * then fall through to the same finish path as reaching `#EXT-X-ENDLIST` naturally (remux once,
 * produce output) — as opposed to `CANCEL`, which discards. No-op if `jobId` isn't a live job (or
 * isn't running at all): the live poll loop is the only reader of this flag. */
export function stopLiveJob(jobId: string): void {
  const control = jobs.get(jobId);
  if (!control?.live) {
    debugLog(jobId, 'STOP_LIVE ignored — no such job, or not a live job');
    return;
  }
  debugLog(jobId, 'STOP_LIVE requested');
  control.liveStopRequested = true;
}

/** Blocks at a segment/chunk boundary while a PAUSE is pending, then reports whether the job has
 * been cancelled in the meantime — the exact three-line dance (`cancelled?` → `await pause` →
 * `cancelled?`) every loop in this feature repeats between units of work. */
export async function awaitResumeOrCancel(control: JobControl): Promise<boolean> {
  if (control.cancelled) return true;
  if (control.pausedPromise) await control.pausedPromise;
  return control.cancelled;
}
