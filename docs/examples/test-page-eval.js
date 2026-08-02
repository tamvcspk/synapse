/**
 * Manual browser test for `ctx.api.page.eval` (docs/api-inventory.md §6, mục 7 — CHƯA verify bằng
 * browser thật; this script is that verification). Upload via the popup's "Upload script" flow,
 * Grant the `page.eval` scope when prompted (the consent line should show the domain below), then
 * load a page under that domain and check the service worker console (chrome://extensions →
 * Synapse → "service worker" link) for the [page.eval] logs this script writes.
 *
 * Swap 'https://example.com/*' for whatever domain you actually load in your test tab — the grant
 * only covers that match pattern, and this script's own checks (including the deliberate-denial one
 * below) depend on it matching the tab you run it on.
 */
globalThis.__synapseModule = {
  id: 'page-eval-test',
  scopes: [{ scope: 'page.eval', match: ['https://example.com/*'] }],
  async run(input, ctx) {
    try {
      const title = await ctx.api.page.eval('return document.title;');
      console.log('[page.eval] document.title from the page\'s own MAIN world:', title);

      const sum = await ctx.api.page.eval('return args[0] + args[1];', [2, 3]);
      console.log('[page.eval] args round-trip (2 + 3):', sum, sum === 5 ? 'OK' : 'MISMATCH');

      const markerKey = '__synapsePageEvalMarker';
      await ctx.api.page.eval(`window[args[0]] = 'set from page.eval';`, [markerKey]);
      const readBack = await ctx.api.page.eval('return window[args[0]];', [markerKey]);
      console.log(
        '[page.eval] wrote a MAIN-world global then read it back in a separate call:',
        readBack,
        '— to confirm yourself, run `window.' + markerKey + '` in the PAGE\'s own DevTools console ' +
          '(top-left context dropdown set to "top", not this script\'s own world and not the ' +
          "service worker's).",
      );

      try {
        await ctx.api.page.eval('throw new Error("deliberate test error");');
        console.error('[page.eval] FAILED: expected the thrown error to reject this call, it did not');
      } catch (err) {
        console.log('[page.eval] a throw inside code correctly rejected the call:', err.message);
      }
    } catch (err) {
      console.error('[page.eval] FAILED', err);
    }
  },
};

/**
 * To verify the ×match denial path: reload this same script on a tab whose URL does NOT fall under
 * 'https://example.com/*' (without widening the grant above) — every `ctx.api.page.eval(...)` call
 * should reject at `rpc-handler.ts` with `Scope "page.eval" is not granted for module "..."`, and the
 * service worker console should show no sign the call ever reached `chrome.scripting.executeScript`.
 *
 * To verify the CSP blind spot (docs/api-inventory.md §7): load this script on a real page whose
 * `script-src` CSP excludes `unsafe-eval` (varies by site and changes over time, so none is named
 * here — check a candidate site's response headers first) instead of example.com. Every call above
 * should reject with a CSP-shaped error message (Chrome's own "Refused to evaluate a string..."
 * wording) rather than hang or crash the service worker.
 */
