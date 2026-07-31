import type { DownloadEngineRelayedCommand, DownloadJobCheckpoint } from '../../../../shared/download-engine-protocol';
import { handleEngineCommand } from '../../features/media/download/engine.offscreen';
import { sweepStaleOpfsRuns } from '../../utils/opfs-store';

/**
 * docs/ROADMAP.md §8.9 — kicked off immediately on every fresh document load (first launch, or a
 * replacement after the previous one crashed/was reloaded/was removed), clearing any OPFS run files
 * a killed-mid-write predecessor left behind (see `sweepStaleOpfsRuns`'s doc comment for the bug
 * this fixes). NOT awaited here — the listener below awaits this same promise before handling the
 * FIRST command instead, so the message listener itself can still register synchronously and never
 * risk losing a command that arrives before the sweep finishes.
 *
 * docs/ROADMAP.md §8.12 — this document has no `chrome.storage` access of its own (§8.11), so the
 * checkpoint list that decides which run(s) to SPARE from the sweep is fetched from background
 * first. A failure here (background not ready yet, message rejected) falls back to an empty
 * keep-set — i.e. the old unconditional-sweep behavior — rather than skipping the sweep entirely,
 * since a stale-lock OPFS failure (the bug §8.9 exists to prevent) is a worse outcome than losing a
 * resume opportunity.
 */
const readySweep = chrome.runtime
  .sendMessage({ type: 'synapse:list-download-checkpoints-for-sweep' })
  .then((response: { checkpoints?: DownloadJobCheckpoint[] } | undefined) => new Set((response?.checkpoints ?? []).map((c) => c.opfsRunId)))
  .catch(() => new Set<string>())
  .then((keepRunIds) => sweepStaleOpfsRuns(keepRunIds));

/**
 * docs/ROADMAP.md §8.1 — thin wiring only, mirrors ui/dashboard/main.ts's "view wiring, logic lives
 * in utils/" split. background/index.ts is the sole caller of chrome.offscreen.createDocument
 * (utils/offscreen-manager.ts) and forwards every command here once the document is confirmed to
 * exist — this listener is what actually does the work.
 *
 * Bugfix: this used to listen for the client-facing `synapse:download-engine-command` type — the
 * SAME type Side Panel/Dashboard broadcast directly via `chrome.runtime.sendMessage`. Since that
 * call reaches every listening context (not just background's relay), this document received the
 * ORIGINAL broadcast itself in addition to background's relayed copy, once it already existed —
 * every command after the first one in a session landed here twice. Listening only for the distinct
 * `synapse:download-engine-command-relayed` type (which nothing but background's relay ever sends)
 * makes that structurally impossible now, rather than relying on `handleEngineCommand`'s per-op
 * idempotency to paper over it.
 */
chrome.runtime.onMessage.addListener((message: DownloadEngineRelayedCommand | undefined) => {
  if (message?.type !== 'synapse:download-engine-command-relayed') return;
  // Waiting on the SAME `readySweep` promise for every command (rather than awaiting it once at
  // module scope) guarantees the stale-run sweep has FULLY finished — and so cannot race a brand new
  // job's own `createOpfsRun()` and delete the file it just created — while still processing commands
  // in the order they arrived (microtask queue is FIFO for callbacks chained off one settled promise).
  void readySweep.then(() => handleEngineCommand(message));
});
