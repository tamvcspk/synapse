import type { DownloadJobCheckpoint } from '../../../shared/download-engine-protocol';

/**
 * docs/ROADMAP.md §8.12 — plain `chrome.storage.local` CRUD for `DownloadJobCheckpoint`, one entry
 * per `jobId`. Unlike header-replay-rules.ts/download-engine.ts's other background-relayed helpers,
 * this file is used from BOTH sides directly, never through a message relay for the read side:
 * Side Panel is a privileged extension page with its own `chrome.storage` access (same as its
 * existing direct `listDetectedMedia()`/turbo-toggle reads), so it calls `listDownloadJobCheckpoints`
 * here itself. Only the Offscreen Document (utils/download-engine.ts) can't touch `chrome.storage`
 * directly (docs/ROADMAP.md §8.11) — it reaches the save/remove functions here via a
 * background/index.ts relay instead, same pattern as header-replay-rules.ts.
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
