/**
 * docs/ROADMAP.md Track A3 — periodic sweep for `permanent`-lifetime state that should eventually
 * decay, but isn't tied to any tab/navigation event the way `state-lifetime.background.ts`'s two
 * listeners are. `chrome.alarms`, not `setTimeout`, because the service worker does not live long
 * enough for a multi-hour/day timer to ever fire (docs/CLAUDE.md §3.5).
 *
 * Two sweeps, both backend-only per the roadmap's own explicit scope: a UI to let the user change
 * the TTL is blocked on Track D5 (no global Settings page exists yet), so the retention window
 * below is hardcoded.
 */

import { sweepOrphanedCheckpoints } from '../features/media/download/checkpoints';
import { listDetectedMedia } from '../features/media/store';
import { sweepStaleReviewBlobs } from '../utils/blob-store';

const GC_ALARM_NAME = 'synapse:storage-gc';
// Once a day is far more often than a 7-day TTL needs — chosen for negligible overhead, not
// precision; nothing here is time-sensitive at the minute/hour scale.
const GC_SWEEP_INTERVAL_MINUTES = 24 * 60;
// docs/ROADMAP.md Track A3 — "Ship được phần backend trước với TTL hardcode"; the UI to let a user
// change this is blocked on Track D5 (no global Settings page exists yet).
const REVIEW_BLOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Exported for `npm test` — the two sweeps it calls are otherwise only reachable through the
 * `chrome.alarms` listener below, which nothing in `environment: 'node'` can fire.
 *
 * Logs what it actually did, unconditionally (not just on error) — a sweep that finds nothing
 * eligible has NO OTHER observable effect, so without this a real "the alarm never fired" bug and
 * "it fired and correctly found nothing to sweep" are indistinguishable from the service worker
 * console. See also `__synapseStorageGc` below for triggering this on demand while testing, instead
 * of waiting for the real (up to 1-day) `chrome.alarms` interval.
 */
export async function runStorageGcSweep(): Promise<void> {
  const detectedMedia = await listDetectedMedia();
  const detectedMediaIds = new Set(detectedMedia.map((m) => m.id));
  const [orphanedCheckpoints, staleBlobsDeleted] = await Promise.all([
    sweepOrphanedCheckpoints(detectedMediaIds),
    sweepStaleReviewBlobs(REVIEW_BLOB_TTL_MS),
  ]);
  console.log(`Synapse: storage GC sweep ran — orphaned checkpoints removed: [${orphanedCheckpoints.join(', ')}], stale review blobs deleted: ${staleBlobsDeleted}`);
}

/** Idempotent — `chrome.alarms.create` replaces any existing alarm of the same name, so calling
 * this on every service-worker startup (same posture as `network-sniffer.background.ts`'s
 * unconditional listener install) never creates a duplicate schedule. First fire ~1 minute after
 * startup rather than immediately, so it doesn't compete with everything else initializing during
 * the worker's first tick; daily thereafter. */
export function installStorageGcAlarm(): void {
  chrome.alarms.create(GC_ALARM_NAME, { delayInMinutes: 1, periodInMinutes: GC_SWEEP_INTERVAL_MINUTES });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== GC_ALARM_NAME) return;
    void runStorageGcSweep().catch((err) => console.error('Synapse: storage GC sweep failed', err));
  });
}

/** Debug-only handle, same posture as `network-sniffer.background.ts`'s `__synapseSniffer` — lets
 * the sweep be triggered ON DEMAND from the service worker console (`await
 * __synapseStorageGc.runSweep()`) instead of waiting for the real `chrome.alarms` interval (up to a
 * day) or temporarily hacking `GC_SWEEP_INTERVAL_MINUTES`/`REVIEW_BLOB_TTL_MS` in source just to
 * test. Namespaced, read/call-only, never read back by any code path. */
(globalThis as unknown as Record<string, unknown>).__synapseStorageGc = { runSweep: runStorageGcSweep };
