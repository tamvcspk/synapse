__synapseModule = {
  id: 'net-mock-test',
  // net.mock.debugger is only needed to REWRITE THE BODY of a request that <img>/<script> tags make
  // (not fetch/XHR) — see the 3rd scenario below. Leave it out if you only want the first two.
  scopes: [
    { scope: 'net.mock', match: ['https://example.com/*'] },
    { scope: 'net.mock.debugger', match: ['https://example.com/*'] },
  ],
  async run(input, ctx) {
    try {
      const existing = await ctx.api.net.mock.list();

      if (existing.length > 0) {
        // Idempotent on purpose — safe to re-run (reload the page) as many times as you like while
        // testing. This script never auto-removes its rules: see the removal instructions below for
        // why, and how to actually clean them up.
        console.log('[net.mock] Rules already active (added by an earlier run):', existing);
        console.log(
          '[net.mock] To verify them, open the ORDINARY DevTools console for this page — the one ' +
            'that opens with F12 while the page itself has focus, with the top-left context dropdown ' +
            'set to "top". NOT the extension\'s service worker console (a third, unrelated context), ' +
            "and NOT this script's own log above (a separate world with its own unpatched fetch). In " +
            'that page console:\n' +
            '  1) fake-response (unchanged v1 behavior):\n' +
            "     fetch('https://example.com/synapse-mock-test').then(r => r.json()).then(console.log)\n" +
            '     Expect { hello: "from synapse" } with NO CORS error.\n' +
            '  2) block (mechanism: dnr — Track B2b):\n' +
            "     fetch('https://example.com/synapse-mock-test-block').catch(e => console.log('blocked:', e))\n" +
            '     Expect the fetch to fail at the network layer (not just a JS-side rejection).\n' +
            '  3) rewrite-request on a non-fetch/XHR resource (mechanism: debugger — needs net.mock.debugger):\n' +
            '     Add <script src="https://example.com/synapse-mock-test-rewrite.js"></script> to the ' +
            'page (or open it directly) and check whether it ran the REWRITTEN body, not the original. ' +
            'Chrome should show a persistent "being debugged" banner on this tab while this rule is ' +
            'active — that banner is expected, not a bug.',
        );
        console.log(
          '[net.mock] To remove them: this script deliberately does NOT auto-remove on a later run — ' +
            'reloading the page to pick up newly-added rules (see below) would also re-run this ' +
            'script, and an add-then-immediately-remove-on-next-load would delete the rules before ' +
            'you ever got to test them. Instead, open the Dashboard → Management View → "HTTP Mock & ' +
            'Rewrite" panel, find the rules (endpointPattern shown above), and delete them there — ' +
            'they are visible there like any other rule, just tagged as owned by this script.',
        );
        return;
      }

      const fakeResponse = await ctx.api.net.mock.add({
        endpointPattern: 'https://example.com/synapse-mock-test',
        fakeStatus: 200,
        fakeResponse: { hello: 'from synapse' },
      });
      console.log('[net.mock] add() fake-response OK, id =', fakeResponse.id);

      const block = await ctx.api.net.mock.add({
        endpointPattern: 'https://example.com/synapse-mock-test-block',
        action: 'block',
      });
      console.log('[net.mock] add() block OK, id =', block.id, '— should resolve to mechanism "dnr"');

      try {
        const rewrite = await ctx.api.net.mock.add({
          endpointPattern: 'https://example.com/synapse-mock-test-rewrite.js',
          action: 'rewrite-request',
          rewriteBody: 'console.log("REWRITTEN by synapse net.mock.debugger");',
          matchAnyResourceType: true, // this + rewriteBody is what pushes the mechanism to 'debugger'
        });
        console.log('[net.mock] add() rewrite-request (debugger) OK, id =', rewrite.id);
      } catch (err) {
        console.error(
          '[net.mock] rewrite-request (debugger) FAILED — most likely "net.mock.debugger" is not ' +
            'granted yet. Check the Grant prompt for this script and re-run.',
          err,
        );
      }

      console.log(
        '[net.mock] IMPORTANT: none of this intercepts anything yet on THIS page. `add()` registers ' +
          'the interceptor via chrome.scripting.registerContentScripts, which — like an uploaded ' +
          'script itself — only takes effect on the NEXT navigation of a tab, never retroactively on ' +
          'a page that was already loaded when it was registered. Reload this page once, which re-runs ' +
          'this script — it will then report the rules as already active and give you the 3 checks above.',
      );
    } catch (err) {
      console.error('[net.mock] FAILED', err);
    }
  },
};
