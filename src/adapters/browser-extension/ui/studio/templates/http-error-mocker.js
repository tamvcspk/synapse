/**
 * TEMPLATE — starting point for a "fake an API response" script (docs/ROADMAP.md §12.4).
 *
 * What this does TODAY — a REAL working equivalent, not a downgraded approximation: `net.mock`
 * lets a script fake a response the same way the builtin's "fake-response" action does.
 *
 * What it CANNOT do, compared to the builtin "HTTP Mock & Rewrite":
 * - `action: 'fake-response'` only — no block, no rewrite-then-forward. Those need a mechanism
 *   (`debugger` or `dnr`) a script cannot request; see below.
 * - Always the `main-world` mechanism (a `fetch`/`XMLHttpRequest` patch) — no `debugger` (visible
 *   in DevTools' Network tab, catches file/image requests too) and no `dnr` (works before ANY page
 *   JS runs). A script never picks the mechanism; the platform always picks the cheapest one.
 * - `endpointPattern` needs a literal scheme+host (only the path may use `*`), and must fall under
 *   a `match` pattern this script was granted for `net.mock` — unlike the builtin's Management View
 *   panel, which has no per-origin grant to satisfy (it's trusted build-time code).
 *
 * Missing scopes for full parity: none block THIS action — `fake-response`/`main-world` is fully
 * available today. Block/rewrite and the other two mechanisms have no scope at all yet.
 */
__synapseModule = {
  id: 'mock-lite',
  scopes: [{ scope: 'net.mock', match: ['https://api.example.com/*'] }],

  async run(input, ctx) {
    const { id } = await ctx.api.net.mock.add({
      endpointPattern: 'https://api.example.com/*',
      fakeStatus: 200,
      fakeResponse: { ok: true, mocked: true },
    });
    console.log(`Mocking https://api.example.com/* as this script's rule ${id}. Edit the match/endpointPattern above for your own API.`);
  },
};
