import type { DownloadJobCheckpoint } from '../../../../../shared/download-engine-protocol';

/**
 * docs/ROADMAP.md §8.12 — plain `chrome.storage.local` CRUD for `DownloadJobCheckpoint`, one entry
 * per `jobId`. Unlike the engine's other background-relayed helpers
 * (./background-relay.offscreen.ts, utils/header-replay-rules.ts), this file is used from BOTH sides
 * directly, never through a message relay for the read side: Side Panel is a privileged extension
 * page with its own `chrome.storage` access (same as its existing direct
 * `listDetectedMedia()`/turbo-toggle reads), so it calls `listDownloadJobCheckpoints` here itself.
 * Only the Offscreen Document can't touch `chrome.storage` directly (docs/ROADMAP.md §8.11) — it
 * reaches the save/remove functions here via a background/index.ts relay instead, same pattern as
 * utils/header-replay-rules.ts.
 *
 * NO `.offscreen.ts`/`.background.ts` suffix on purpose (docs/ROADMAP.md §11.5's convention): this
 * is the one file in this folder that genuinely runs in more than one context, and the suffix is
 * meant to warn about a context's limits, not to decorate every file in a folder.
 */

const STORAGE_KEY = 'network-sniffer:downloadJobs';

export async function listDownloadJobCheckpoints(): Promise<DownloadJobCheckpoint[]> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as DownloadJobCheckpoint[] | undefined) ?? [];
}

/** Upsert by `jobId` — a job checkpoints many times over its lifetime, always replacing its own
 * previous entry, never appending a new one. */
export async function saveDownloadJobCheckpoint(checkpoint: DownloadJobCheckpoint): Promise<void> {
  const existing = await listDownloadJobCheckpoints();
  const next = [...existing.filter((c) => c.jobId !== checkpoint.jobId), checkpoint];
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
}

/** No-op if `jobId` isn't found — removal is called unconditionally whenever a job reaches ANY
 * terminal state (done/error/cancelled, docs/ROADMAP.md §8.12), so "already gone" is a normal,
 * frequent outcome here, not a bug. */
export async function removeDownloadJobCheckpoint(jobId: string): Promise<void> {
  const existing = await listDownloadJobCheckpoints();
  await chrome.storage.local.set({ [STORAGE_KEY]: existing.filter((c) => c.jobId !== jobId) });
}

/** docs/ROADMAP.md Track A3 — pure set-difference: a checkpoint's `jobId` IS the id of the
 * `DetectedMedia` entry it resumes (`ui/side-panel/main.ts`'s `checkpoints.find((c) => c.jobId ===
 * item.id)`), so a checkpoint whose id isn't in `detectedMediaIds` has no `DetectedMedia` left to
 * resume OR to be cleaned up alongside — evicted (e.g. by `MAX_DETECTED_ITEMS`, or Track A1's
 * navigation eviction) with the checkpoint left behind, no UI surface pointing at it anymore.
 * Extracted as a pure function so the actual decision is testable without `chrome.storage`
 * (`sweepOrphanedCheckpoints` below is the untested chrome.storage-touching orchestration). */
export function orphanedCheckpointIds(checkpoints: DownloadJobCheckpoint[], detectedMediaIds: ReadonlySet<string>): string[] {
  return checkpoints.filter((c) => !detectedMediaIds.has(c.jobId)).map((c) => c.jobId);
}

/** docs/ROADMAP.md Track A3 — called periodically from `background/storage-gc.ts`'s
 * `chrome.alarms` sweep. Takes `detectedMediaIds` as a Set the caller already has in hand (it needs
 * the full `DetectedMedia[]` for its OWN sweep pass too), rather than importing `listDetectedMedia`
 * here and re-fetching — keeps this file's existing "no cross-feature import" shape unchanged. */
export async function sweepOrphanedCheckpoints(detectedMediaIds: ReadonlySet<string>): Promise<string[]> {
  const checkpoints = await listDownloadJobCheckpoints();
  const orphaned = orphanedCheckpointIds(checkpoints, detectedMediaIds);
  if (orphaned.length === 0) return orphaned;
  await chrome.storage.local.set({ [STORAGE_KEY]: checkpoints.filter((c) => !orphaned.includes(c.jobId)) });
  return orphaned;
}
