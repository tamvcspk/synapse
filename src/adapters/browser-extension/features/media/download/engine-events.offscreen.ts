import type { DownloadEngineEvent, DownloadEnginePhase } from '../../../../../shared/download-engine-protocol';

/**
 * docs/ROADMAP.md §8.1/§11.2 — how the headless engine talks back to whichever UI surface started a
 * job. Split out of the old utils/download-engine.ts (Phase 1) because literally every other file in
 * this folder needs `emit`/`debugLog` and nothing else about them: keeping them here is what stops
 * the job-kind modules from having to import each other just to report progress.
 *
 * `.offscreen.ts` suffix (docs/ROADMAP.md §11.5's convention, adopted early for exactly the reason
 * it exists): moving this code out of `utils/` loses the execution-context signal the old file's
 * path and doc comment carried. Everything in this folder with that suffix runs inside the singleton
 * Offscreen Document, where ONLY `chrome.runtime` is available — no `chrome.storage`, no
 * `chrome.downloads`, no `chrome.declarativeNetRequest` (docs/LESSONS.md; they fail at CALL time,
 * not import time, which is how header replay stayed silently broken for weeks in §8.11).
 */

/** Debug-only state tracing, added while chasing a real report of a job hanging on "Starting…" with
 * nothing in the offscreen document's own console to explain why (chrome://extensions' "Inspect
 * views" → offscreen.html) — every command received, every event emitted, and every `inFlight`
 * transition shows up there with a `[download-engine]` prefix, so a future repro can be read
 * straight off the console instead of guessed at from code. Deliberately left in (not stripped for
 * "production") — this extension has no telemetry/analytics of its own, and this is the ONLY place
 * that would ever surface exactly what the engine did for a given `jobId`. */
export function debugLog(jobId: string, message: string, extra?: Record<string, unknown>): void {
  console.log(`[download-engine] ${jobId}: ${message}`, extra ?? '');
}

export function emit(jobId: string, phase: DownloadEnginePhase, extra?: Partial<DownloadEngineEvent>): void {
  const event: DownloadEngineEvent = { type: 'synapse:download-engine-event', jobId, phase, ...extra };
  debugLog(jobId, `emit '${phase}'`, extra);
  chrome.runtime.sendMessage(event).catch((err: unknown) => {
    // Side Panel not open, or closed mid-download — expected and harmless (docs/ROADMAP.md §7.6's
    // existing "no persistence" posture), but worth a trace line since it explains a UI that looks
    // stuck: the event was sent, just never delivered anywhere.
    debugLog(jobId, `emit '${phase}' had no listener (sendMessage rejected)`, { error: String(err) });
  });
}
