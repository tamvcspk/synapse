/**
 * Manual browser test for `synapseApi.pipeline.hook` (docs/ROADMAP.md §11.6 item 8 — implemented,
 * NOT yet verified on real Chrome; this script is that verification).
 *
 * Self-contained on purpose — unlike `test-ai-ask.js`/`test-secrets.js`, this needs no external
 * site, Dashboard secret, or local server. `run()` injects its own synthetic `blob:` `<video>` that
 * none of the platform's 3 existing correlation signals (HLS attribute, MediaSource blob-URL map,
 * 'play' event) can ever resolve — no hls.js instance touches it, no MediaSource, it's never played
 * — which is exactly the gap `[§7.3-open]` left open for this 4th, hook-based signal to fill.
 *
 * PREREQUISITES:
 * 1. **Enable "Network Sniffer" in the popup first.** It defaults to OFF (docs/ROADMAP.md §12.4's
 *    default-off builtins). The 4th correlation signal this test exercises lives inside that
 *    Module's own content-script observer (`dom-media-observer.content.ts`) — if it's off, that
 *    observer never installs on the page at all, so the synthetic `<video>` injected below is never
 *    scanned and the hook is never fired. Symptom if you skip this: check 1 (registration) still
 *    succeeds, but you never see a "handler invoked" log — nothing wrong with `pipeline.hook`
 *    itself, the platform code that would call it just never ran.
 * 2. Upload this script via the popup. Grant `media` when prompted (`pipeline.hook` for
 *    `media.correlate-url` reuses that scope — see `kernel/scopes.ts`'s `pipeline.hook` entry).
 * 3. Load ANY page (this script's `match` below covers every URL, so it doesn't matter which one) and
 *    open THAT tab's own DevTools console (F12) — NOT the service worker console — to see `run()`'s
 *    `console.log` output. Or use Studio's "Run once on this tab" (Dry Run).
 */
__synapseModule = {
  id: 'pipeline-hook-test',
  scopes: ['media'],
  async run(input, ctx) {
    // 1. Register the hook. Should resolve to an unsubscribe function — `media` is granted, and
    //    'media.correlate-url' is the one known slot (an unknown slot name would be rejected by
    //    pipeline-hook-store.ts's fail-closed allowlist, not tested here since the type itself
    //    only accepts that one literal).
    let unsubscribe;
    try {
      unsubscribe = await ctx.api.pipeline.hook('media.correlate-url', {
        match: ['*://*/*'],
        handler: (fireCtx) => {
          console.log('[pipeline-hook] handler invoked, fireCtx =', JSON.stringify(fireCtx));
          const el = document.getElementById('synapse-pipeline-hook-test-video');
          if (!el) return [];
          // The URL here is fake (nothing downloadable) — this test only checks that the platform
          // relays it back and anchors a badge to the right element, not that it's a real playable
          // manifest.
          return [{ cssSelector: '#synapse-pipeline-hook-test-video', url: 'https://example.com/fake-manifest.m3u8' }];
        },
      });
      console.log('[pipeline-hook] 1) OK — hook registered, unsubscribe is a', typeof unsubscribe);
    } catch (err) {
      console.error('[pipeline-hook] 1) FAILED (expected registration to succeed with media granted)', err);
      return;
    }

    // 2. Inject the synthetic blob: <video> — see file header for why this element specifically can
    //    never be resolved by the 3 built-in signals.
    const blobUrl = URL.createObjectURL(new Blob(['not a real video'], { type: 'video/mp4' }));
    const video = document.createElement('video');
    video.id = 'synapse-pipeline-hook-test-video';
    video.src = blobUrl;
    document.body.appendChild(video);
    console.log('[pipeline-hook] 2) injected a synthetic blob: <video> —', blobUrl);
    console.log('[pipeline-hook] Wait a few seconds, then check:');
    console.log('[pipeline-hook]   a) this console shows "handler invoked" (above) — the platform found this element unresolved and fired the slot.');
    console.log('[pipeline-hook]   b) the <video> element (bottom of the page) now has a small ⬇ badge in its corner.');
    console.log('[pipeline-hook]   c) hovering the badge shows "Best-effort match — this player streams via a technique we can\'t inspect directly".');

    // 3. Unhook, re-append a SECOND synthetic element, and confirm the handler is no longer called —
    //    proves `unsubscribe()` actually reaches pipeline-hook-store.ts (pipeline.unregister), not
    //    just the local closure.
    setTimeout(() => {
      unsubscribe();
      console.log('[pipeline-hook] 3) unsubscribed — injecting a second synthetic <video>; the handler log above should NOT appear again for it.');
      const blobUrl2 = URL.createObjectURL(new Blob(['not a real video either'], { type: 'video/mp4' }));
      const video2 = document.createElement('video');
      video2.id = 'synapse-pipeline-hook-test-video-2';
      video2.src = blobUrl2;
      document.body.appendChild(video2);
    }, 5000);
  },
};

/**
 * A second check that needs a state change this single run() can't produce on its own:
 *
 * 4. **Conflict resolution — more specific `match` wins.** Upload a SECOND script with a different
 *    `id`, the SAME `scopes: ['media']`, hooking the SAME slot with a narrower `match` (e.g.
 *    `['*://example.com/*']` if you're testing on example.com) and a handler that returns a
 *    DIFFERENT fake URL. With both scripts active on a matching page, re-run the injection above —
 *    the badge's `onClick` (Side Panel download attempt) should carry the SECOND script's URL, not
 *    this one's, confirming `resolveHookWinner`'s specificity rule picked the narrower `match`
 *    pattern over this file's own match-everything pattern.
 */
