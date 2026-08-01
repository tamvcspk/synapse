import type { DownloadJobCheckpoint } from '../../../../../shared/download-engine-protocol';
import type { DescribeHeaderReplayResult } from '../header-replay-rules';
import { debugLog } from './engine-events.offscreen';

/**
 * docs/ROADMAP.md §8.11/§8.12/§11.2 — everything the engine needs that an Offscreen Document is not
 * allowed to do itself. Split out of utils/download-engine.ts (Phase 1) so the job-kind modules read
 * as "download bytes, write bytes" and every privileged detour is visible in one file.
 *
 * Offscreen documents can use ONLY `chrome.runtime` — confirmed against Chrome's own docs after
 * `chrome.downloads.download()` threw "Cannot read properties of undefined" from inside the engine
 * during a real download. `chrome.storage`, `chrome.declarativeNetRequest` and `chrome.downloads`
 * are all unavailable here despite no error at IMPORT time (the failure only surfaces the first time
 * the call actually runs). Header replay's `chrome.storage`/`chrome.declarativeNetRequest` calls
 * used to be made directly from the engine — silently broken (swallowed by `.catch(() => undefined)`)
 * for every download since the engine moved into the Offscreen Document, never crashing, just
 * quietly never replaying captured headers. Every one of these now goes through background/index.ts,
 * which has full `chrome.*` access.
 */
export async function requestFromBackground<T>(message: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

/** docs/ROADMAP.md §8.12 — same relay pattern: this document has no `chrome.storage` of its own, so
 * persisting/clearing a checkpoint round-trips through background (./checkpoints.ts). Both are
 * fire-and-forget from the CALLER's point of view — a dropped checkpoint write just means resume
 * falls back a little further than it could have; it never corrupts anything, since a resume always
 * re-validates against the OPFS file's real size before trusting one (utils/opfs-store.ts's
 * `tryResumeOpfsRun`). Bugfix-in-waiting (§8.8's lesson applied preemptively): a bare
 * `.catch(() => {})` here would silently swallow a broken relay exactly the way §8.11 found header
 * replay had been broken for weeks — logged instead, even though a failure here is non-fatal to THIS
 * download. */
export async function persistCheckpoint(checkpoint: DownloadJobCheckpoint): Promise<void> {
  await requestFromBackground<{ ok?: boolean }>({ type: 'synapse:save-download-checkpoint', checkpoint }).catch((err: unknown) => {
    debugLog(checkpoint.jobId, 'checkpoint save failed to reach background (resume will fall back further than it could have)', { error: err instanceof Error ? err.message : String(err) });
  });
}

export async function clearCheckpoint(jobId: string): Promise<void> {
  await requestFromBackground<{ ok?: boolean }>({ type: 'synapse:remove-download-checkpoint', jobId }).catch((err: unknown) => {
    debugLog(jobId, 'checkpoint clear failed to reach background (a stale checkpoint may linger until the next Offscreen Document sweep)', { error: err instanceof Error ? err.message : String(err) });
  });
}

/** docs/ROADMAP.md §7.1 — the entry that had this URL (as its own `url`, or as one of its
 * `variants`) is the one whose captured headers apply here. Looked up in background since it needs
 * `chrome.storage`. */
async function findReplayHeaders(url: string): Promise<Record<string, string> | undefined> {
  const response = await requestFromBackground<{ headers?: Record<string, string> }>({ type: 'synapse:query-replay-headers', url });
  return response?.headers;
}

/** A no-op-or-sync-the-DNR-rule callback, awaited immediately before every request a job makes. */
export type ReplayHeadersFor = (url: string) => Promise<void>;

/** docs/ROADMAP.md §7.1/§8.2 — shared by all job kinds: looks up whichever `DetectedMedia` entry
 * captured headers for `referenceUrl`, then returns a `replayHeadersFor(url)` closure that no-ops
 * when there's nothing captured, and dedupes by host (a job's URLs overwhelmingly share one host, so
 * this avoids hundreds of redundant relay round-trips to background for the same
 * `chrome.declarativeNetRequest` rule). */
export async function createReplayHeaderApplier(referenceUrl: string): Promise<ReplayHeadersFor> {
  const replayHeaders = await findReplayHeaders(referenceUrl).catch(() => undefined);
  const hostsSynced = new Set<string>();
  return async (url: string) => {
    if (!replayHeaders) return;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }
    if (hostsSynced.has(host)) return;
    hostsSynced.add(host);
    await requestFromBackground({ type: 'synapse:sync-header-replay-rule', host, headers: replayHeaders }).catch(() => {});
  };
}

/** Called on a segment/chunk 401/403 so the engine can explain WHY the CDN rejected it. */
export type AuthFailureReporter = (url: string, statusCode: number) => Promise<void>;

/**
 * docs/ROADMAP.md §7.1 — a one-shot diagnostic on the FIRST segment 401/403 of a job, console-only
 * (there's no Tab UI to surface it in — the offscreen document's console is reachable via
 * chrome://extensions' "Inspect views", same as the background service worker's). Previously two
 * near-identical copies inside the VOD and live jobs, kept apart only because each closed over its
 * own `sourceUrl`/`authDiagnosticLogged`; `label` is the one thing that actually differed between
 * them, so it's a parameter now instead of a reason to duplicate 20 lines.
 *
 * Simplified from the old Merge-page version: that one also diagnosed a "wrong tabIds" mismatch,
 * which no longer applies now every fetch here uses the same TAB_ID_NONE scope background's own
 * fetches already share.
 */
export function createAuthDiagnostics(manifestUrl: string, label: string): AuthFailureReporter {
  let logged = false;
  return async (url: string, statusCode: number) => {
    if (logged) return;
    logged = true;
    try {
      const host = new URL(url).hostname;
      const replay = await requestFromBackground<DescribeHeaderReplayResult>({ type: 'synapse:describe-header-replay', host });
      const likelyCause = !replay.intended
        ? `No headers were captured for this manifest, or syncHeaderReplayRule was never called for ${host} — the CDN saw a bare extension request.`
        : !replay.liveRule
          ? `Rule ${replay.intended.ruleId} was synced for ${host} but is not in the live session ruleset — evicted by MAX_HOSTS, or updateSessionRules failed (check for an earlier console error from header-replay-rules).`
          : `Rule ${replay.intended.ruleId} is live and carries ${replay.intended.headerNames.join(', ')}. So either (a) Chrome overrode a value after the rule applied (it does this for Origin on CORS-mode requests), or (b) this CDN gates on something other than these headers.`;
      console.warn(`Synapse: ${label} fetch got HTTP ${statusCode} — header replay did not satisfy ${host}.\n\nLikely cause: ${likelyCause}`, {
        segmentUrl: url,
        manifestUrl,
        ...replay,
      });
    } catch {
      // Diagnostics must never mask the real error the caller is already reporting.
    }
  };
}
