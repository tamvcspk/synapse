import type { CacheService } from '../../../kernel/module';
import type {
  SynapseMediaControlAction,
  SynapseMediaDownloadOptions,
  SynapseMediaEntry,
  SynapseMediaInspectResult,
  SynapseMediaJobStatus,
} from '../../../kernel/synapse-api';
import type { DownloadEngineCommand, DownloadEngineEvent } from '../../../shared/download-engine-protocol';
import { parseM3u8 } from '../../../shared/media-manifest-parser';
import { classifyMediaUrl } from '../../../shared/media-url-matcher';
import { chromeStorageCache } from '../background/services/cache';
import { relayDownloadEngineCommand } from '../features/media/download/engine-relay.background';
import { collapseVariantShadowedEntries, listDetectedMedia, type DetectedMedia } from '../features/media/store';
import { pushSubscriptionEvent } from './subscription-push';

/**
 * Backs `synapseApi.media.*` (docs/api-inventory.md §3.1 — "phần việc lớn nhất" of the trần
 * catalog). `list`/`inspect` are read-only projections of infrastructure that already exists
 * (`network-sniffer.background.ts`'s detection + auto-inspect); `download`/`job`/`control` are the
 * id-based facade §3.1 calls for, fronting the same `DownloadEngineCommand`/`DownloadEngineEvent`
 * protocol the Side Panel already speaks (`shared/download-engine-protocol.ts`) — a script never
 * sees the engine's live objects (`AbortController`, an OPFS run), only a `jobId` string.
 */

function toSynapseMediaEntry(m: DetectedMedia): SynapseMediaEntry {
  const entry: SynapseMediaEntry = { id: m.id, url: m.url, kind: m.kind, detectedAt: m.detectedAt };
  if (m.pageUrl !== undefined) entry.pageUrl = m.pageUrl;
  if (m.tabUrl !== undefined) entry.tabUrl = m.tabUrl;
  if (m.thirdParty !== undefined) entry.thirdParty = m.thirdParty;
  if (m.expiring !== undefined) entry.expiring = m.expiring;
  if (m.resolution !== undefined) entry.resolution = m.resolution;
  if (m.segmentCount !== undefined) entry.segmentCount = m.segmentCount;
  if (m.encrypted !== undefined) entry.encrypted = m.encrypted;
  if (m.variants !== undefined) entry.variants = m.variants;
  return entry;
}

export async function performMediaList(cache: CacheService = chromeStorageCache): Promise<SynapseMediaEntry[]> {
  const items = await listDetectedMedia(cache);
  return collapseVariantShadowedEntries(items).map(toSynapseMediaEntry);
}

/**
 * Always a fresh fetch+parse, never a read of the auto-inspected fields `list()` already returns —
 * those cover `variants`/`segments`/`encrypted` but not `live` (network-sniffer's own auto-inspect,
 * `inspectStreamEntry`, never persists it, since nothing there needed it before now). A URL that
 * isn't parseable HLS (wrong content, DASH `.mpd`, a dead link) resolves to `{}` rather than
 * throwing — the same "honest primitive, no crafted fallback" posture as `lib.readable`.
 */
export async function performMediaInspect(url: unknown): Promise<SynapseMediaInspectResult> {
  if (typeof url !== 'string' || url === '') {
    throw new Error('media.inspect: "url" is required');
  }

  let manifest;
  try {
    manifest = parseM3u8(await (await fetch(url)).text(), url);
  } catch (err) {
    throw new Error(`media.inspect: could not fetch/parse "${url}" (${err instanceof Error ? err.message : String(err)})`);
  }

  if (manifest.kind === 'master') return { variants: manifest.variants };
  if (manifest.kind === 'media') return { segments: manifest.segments.length, encrypted: manifest.encrypted, live: manifest.isLive };
  return {};
}

/** Where a `media.download`/`.control` call actually reaches the engine — injected (default: the
 * real ensure-offscreen-doc-then-relay) so this file is unit-testable without `chrome.offscreen`.
 * Same DI pattern `net-mock-host.ts`'s `MockRuleStore` uses for the same reason. */
export interface DownloadEngineTransport {
  send(command: DownloadEngineCommand): Promise<void>;
}

const realTransport: DownloadEngineTransport = { send: relayDownloadEngineCommand };

/** `jobId` → the tab that started it, ONLY when that tab is known (an RPC caller — a content-script
 * dom Module or an uploaded script; a background Module has no tab of its own, see
 * `synapse-api-host.ts`'s `pageApiFor` for the same absent-tabId case). Backs the push half of
 * `onProgress` (docs/api-inventory.md §6 item 8): `recordMediaJobSnapshot` reads this to know WHERE
 * to push, the same way `jobSnapshots` below answers WHAT to push. In-memory only, same
 * service-worker-lifetime posture as `jobSnapshots` — entries are removed once a job reaches a
 * terminal phase so this cannot grow without bound across a long session. */
const jobTabOwners = new Map<string, number>();

const TERMINAL_PHASES: ReadonlySet<SynapseMediaJobStatus['phase']> = new Set(['done', 'error', 'cancelled']);

export async function performMediaDownload(
  options: SynapseMediaDownloadOptions,
  tabId?: number,
  transport: DownloadEngineTransport = realTransport,
): Promise<string> {
  if (typeof options?.url !== 'string' || options.url === '') {
    throw new Error('media.download: "url" is required');
  }
  // `.m3u8`/`.mpd` run the HLS/segment engine (`op: 'START'`); a recognized non-stream extension
  // (`.mp4`/`.mp3`/…) runs the multi-connection direct-file downloader (`op: 'START_TURBO'`) — the
  // same branch the Side Panel's own Download button takes off `DetectedMedia.kind`
  // (`ui/side-panel/main.ts`). Anything unrecognized is refused before a job is ever created, rather
  // than handed to an engine that has no idea what to do with it.
  const kind = classifyMediaUrl(options.url);
  if (!kind) {
    throw new Error('media.download: "url" is not a recognized media file — pass a URL from media.list() or media.inspect()');
  }

  const jobId = crypto.randomUUID();
  const command: DownloadEngineCommand =
    kind === 'stream'
      ? {
          type: 'synapse:download-engine-command',
          op: 'START',
          jobId,
          url: options.url,
          ...(options.resolutionLabel !== undefined ? { resolutionLabel: options.resolutionLabel } : {}),
        }
      : { type: 'synapse:download-engine-command', op: 'START_TURBO', jobId, url: options.url };

  if (tabId !== undefined) jobTabOwners.set(jobId, tabId);
  await transport.send(command);
  return jobId;
}

/** In-memory only — no `chrome.storage`, matching `docs/ROADMAP.md §7.6`'s existing "download
 * progress is not persisted" posture. A background service-worker restart mid-download loses every
 * snapshot; `media.job()` resolving to `undefined` afterward is the documented consequence
 * (`SynapseMediaJobStatus`'s own doc comment), not a bug to route around. */
export interface MediaJobSnapshotStore {
  get(jobId: string): SynapseMediaJobStatus | undefined;
  set(jobId: string, status: SynapseMediaJobStatus): void;
}

const jobSnapshots = new Map<string, SynapseMediaJobStatus>();
const realSnapshotStore: MediaJobSnapshotStore = {
  get: (jobId) => jobSnapshots.get(jobId),
  set: (jobId, status) => jobSnapshots.set(jobId, status),
};

/** Backs `synapseApi.media.onProgress` for the IN-PROCESS transport only (a background Module,
 * wired straight to this in `synapse-api-host.ts`) — no `chrome.*` messaging involved at all, since
 * a background Module already runs in this exact JS realm. This is the one of the three
 * `onProgress` implementations that needs no spike: it is the same in-memory pub/sub a plain
 * `EventTarget` would give, just without one, matching `jobSnapshots`'s existing "a Map is enough"
 * posture. The content-script/USER_SCRIPT transports (`rpc-client.ts`, `user-script-shim.ts`) are
 * the ones crossing a world boundary — see `pushSubscriptionEvent` below for that half. */
const localProgressListeners = new Map<string, Set<(status: SynapseMediaJobStatus) => void>>();

export function onMediaProgressLocal(jobId: string, handler: (status: SynapseMediaJobStatus) => void): () => void {
  let handlers = localProgressListeners.get(jobId);
  if (!handlers) {
    handlers = new Set();
    localProgressListeners.set(jobId, handlers);
  }
  handlers.add(handler);
  return () => {
    handlers!.delete(handler);
    if (handlers!.size === 0) localProgressListeners.delete(jobId);
  };
}

/** Where a push actually goes out — injected so `recordMediaJobSnapshot` stays unit-testable
 * without `chrome.tabs`, the same DI shape `DownloadEngineTransport` uses for the same reason. */
export interface MediaProgressPushTransport {
  push(tabId: number, jobId: string, status: SynapseMediaJobStatus): void;
}
const realPushTransport: MediaProgressPushTransport = {
  push: (tabId, jobId, status) => pushSubscriptionEvent(tabId, `media.progress:${jobId}`, status),
};

/** Called from `background/index.ts`'s own `synapse:download-engine-event` listener for EVERY
 * broadcast the engine emits (not just ones a script started) — same reasoning `net.mock`'s
 * `ownerModuleId` isolation applies at the read side instead of the write side: recording every
 * event is cheap and harmless, `performMediaJob` doesn't know or care who started a job, and a
 * script polling a `jobId` it never started (someone else's, or the Side Panel's own) learns nothing
 * it couldn't already see for itself in the Side Panel UI. `onProgress` (docs/api-inventory.md §6
 * item 8) inherits the same openness deliberately, not as an oversight: it only ever fires for a
 * jobId the caller already knows (from `download()`'s own return value or a `list()`/Side-Panel
 * read), so broadcasting every event costs nothing new. */
export function recordMediaJobSnapshot(
  event: DownloadEngineEvent,
  store: MediaJobSnapshotStore = realSnapshotStore,
  pushTransport: MediaProgressPushTransport = realPushTransport,
): void {
  const status: SynapseMediaJobStatus = { phase: event.phase };
  if (event.segmentsDone !== undefined) status.done = event.segmentsDone;
  if (event.segmentsTotal !== undefined) status.total = event.segmentsTotal;
  if (event.phase === 'error' && event.message !== undefined) status.error = event.message;
  store.set(event.jobId, status);

  for (const handler of localProgressListeners.get(event.jobId) ?? []) handler(status);

  const tabId = jobTabOwners.get(event.jobId);
  if (tabId !== undefined) {
    pushTransport.push(tabId, event.jobId, status);
    if (TERMINAL_PHASES.has(event.phase)) jobTabOwners.delete(event.jobId);
  }
}

export async function performMediaJob(jobId: unknown, store: MediaJobSnapshotStore = realSnapshotStore): Promise<SynapseMediaJobStatus | undefined> {
  if (typeof jobId !== 'string' || jobId === '') {
    throw new Error('media.job: "jobId" is required');
  }
  return store.get(jobId);
}

const ACTION_TO_OP: Record<SynapseMediaControlAction, DownloadEngineCommand['op']> = {
  pause: 'PAUSE',
  resume: 'RESUME',
  cancel: 'CANCEL',
  'stop-live': 'STOP_LIVE',
};

export async function performMediaControl(
  jobId: unknown,
  action: unknown,
  transport: DownloadEngineTransport = realTransport,
): Promise<void> {
  if (typeof jobId !== 'string' || jobId === '') {
    throw new Error('media.control: "jobId" is required');
  }
  const op = ACTION_TO_OP[action as SynapseMediaControlAction];
  if (!op) {
    throw new Error(`media.control: unknown action "${String(action)}"`);
  }
  await transport.send({ type: 'synapse:download-engine-command', op, jobId });
}
