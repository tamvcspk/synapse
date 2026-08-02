/**
 * Manual browser test for `ctx.api.media.onProgress` (docs/api-inventory.md §4, §6 item 8 — the
 * subscription spike. **Confirmed on real Chrome 2026-08-02** — see docs/LESSONS.md; this script is
 * what produced that verification and is kept as a regression check). Upload via the popup's
 * "Upload script" flow, Grant the `media` scope when prompted, then load a page that has a
 * downloadable video/audio/stream on it (network-sniffer must be active so `media.list()` finds
 * something) and check the service worker console (chrome://extensions → Synapse → "service worker"
 * link) for the [onProgress]/[job poll] logs this script writes.
 *
 * **What this actually tests**: whether the extension can PUSH data INTO the USER_SCRIPT world at
 * all. Every RPC method this codebase had shipped before this only proved the OTHER direction
 * (script → background). `onProgress` registers its handler locally (synchronous, no RPC — see
 * `synapse-api.ts`'s doc comment) and the platform pushes into it via a chain nothing had exercised
 * before: background `chrome.tabs.sendMessage` → content script (ISOLATED world) → a DOM
 * `CustomEvent` on `window` → this script's own `window.addEventListener` in the USER_SCRIPT world.
 * Every hop except the last one was already proven elsewhere in this codebase (MAIN↔ISOLATED); the
 * last hop is the one this spike answered — confirmed working.
 *
 * This script deliberately runs BOTH `onProgress` and `job()` polling side by side on the same
 * download, so a real Chrome run gives a direct comparison — confirmed result from the first real
 * run: `[onProgress]` fired once carrying the same `{phase:'error', ...}` `[job poll]` saw
 * immediately after (the download itself was refused because the test picked a master-playlist
 * entry — that's `media.download` behaving correctly, not a mechanism failure; see §3.1). If a
 * future run ever shows `[onProgress]` NOT firing while `[job poll]` still does, that's a real
 * regression worth investigating, not the expected state.
 */
__synapseModule = {
  id: 'subscription-spike-test',
  scopes: ['media'],
  async run(input, ctx) {
    try {
      const found = await ctx.api.media.list();
      const candidate = found.find((m) => m.kind === 'video' || m.kind === 'audio' || m.kind === 'stream');
      if (!candidate) {
        console.warn('[subscription-spike] no downloadable media detected on this page yet — reload after network-sniffer has found something, or navigate to a page with video/audio.');
        return;
      }
      console.log('[subscription-spike] starting download of', candidate.url);

      const jobId = await ctx.api.media.download({ url: candidate.url });
      console.log('[subscription-spike] jobId:', jobId);

      let pushEventCount = 0;
      let pushSawTerminal = false;
      const unsubscribe = ctx.api.media.onProgress(jobId, (status) => {
        pushEventCount += 1;
        console.log('[onProgress]', pushEventCount, status);
        if (status.phase === 'done' || status.phase === 'error' || status.phase === 'cancelled') {
          pushSawTerminal = true;
        }
      });

      let pollCount = 0;
      let status;
      do {
        await new Promise((r) => setTimeout(r, 1000));
        status = await ctx.api.media.job(jobId);
        pollCount += 1;
        console.log('[job poll]', pollCount, status);
      } while (status && status.phase !== 'done' && status.phase !== 'error' && status.phase !== 'cancelled');

      // Give a straggler push event (if any) a moment to arrive after the poll loop already saw the
      // terminal phase, before concluding the push path is dead for this run.
      await new Promise((r) => setTimeout(r, 1500));
      unsubscribe();

      console.log('[subscription-spike] RESULT:', pushEventCount > 0
        ? `onProgress fired ${pushEventCount} time(s) (terminal phase seen: ${pushSawTerminal}) — push path WORKS.`
        : 'onProgress never fired even once — push path is DEAD, job() polling is the only working path.');
    } catch (err) {
      console.error('[subscription-spike] FAILED', err);
    }
  },
};
