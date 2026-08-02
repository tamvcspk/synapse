globalThis.__synapseModule = {
  id: 'net-mock-test',
  scopes: [{ scope: 'net.mock', match: ['https://example.com/*'] }],
  async run(input, ctx) {
    try {
      const existing = await ctx.api.net.mock.list();

      if (existing.length > 0) {
        // Idempotent on purpose — safe to re-run (reload the page) as many times as you like while
        // testing. This script never auto-removes the rule: see the removal instructions below for
        // why, and how to actually clean it up.
        console.log('[net.mock] Rule already active (added by an earlier run):', existing);
        console.log(
          '[net.mock] To verify it, open the ORDINARY DevTools console for this page — the one that ' +
            'opens with F12 while the page itself has focus, with the top-left context dropdown set ' +
            'to "top". NOT the extension\'s service worker console (a third, unrelated context), and ' +
            "NOT this script's own log above (a separate world with its own unpatched fetch). In " +
            'that page console, run:\n' +
            "  fetch('https://example.com/synapse-mock-test').then(r => r.json()).then(console.log)\n" +
            'Expect { hello: "from synapse" } with NO CORS error.',
        );
        console.log(
          '[net.mock] To remove it: this script deliberately does NOT auto-remove on a later run — ' +
            'reloading the page to pick up a newly-added rule (see below) would also re-run this ' +
            'script, and an add-then-immediately-remove-on-next-load would delete the rule before you ' +
            'ever got to test it. Instead, open the Dashboard → Management View → "HTTP Mock & ' +
            'Rewrite" panel, find the rule (endpointPattern shown above), and delete it there — it is ' +
            'visible there like any other rule, just tagged as owned by this script.',
        );
        return;
      }

      const { id } = await ctx.api.net.mock.add({
        endpointPattern: 'https://example.com/synapse-mock-test',
        fakeStatus: 200,
        fakeResponse: { hello: 'from synapse' },
      });
      console.log('[net.mock] add() OK, id =', id);
      console.log(
        '[net.mock] IMPORTANT: this alone does not intercept anything yet on THIS page. ' +
          '`add()` registers the interceptor via chrome.scripting.registerContentScripts, which — ' +
          'like an uploaded script itself — only takes effect on the NEXT navigation of a tab, never ' +
          'retroactively on a page that was already loaded when it was registered. Reload this page ' +
          'once, which re-runs this script — it will then report the rule as already active and give ' +
          'you the fetch() command to verify with.',
      );
    } catch (err) {
      console.error('[net.mock] FAILED', err);
    }
  },
};
