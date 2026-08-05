/**
 * Manual browser test for `ai.ask` (docs/ROADMAP.md §11.6 — implemented, not yet browser-verified;
 * this script is that verification). Ollama variant: no API key, no Dashboard secret to create
 * first — the fastest path to a real end-to-end call. An OpenAI variant is sketched in a comment at
 * the bottom (needs a Dashboard secret first, same prerequisite as docs/examples/test-secrets.js).
 *
 * PREREQUISITES — do these BEFORE uploading this script:
 *
 * 1. Ollama running locally with at least one model already pulled — check with `ollama list`.
 *    This script defaults to `llama3.1:8b`; change MODEL below to whatever you actually have.
 *
 * 2. **CORS — the #1 blocker, and the reason check 1 below is most likely to fail first.** `ai.ask`
 *    runs in the background service worker, so the request to Ollama carries the origin
 *    `chrome-extension://<this-extension's-id>`, not a normal page origin — Ollama's own
 *    server-side origin allowlist (not browser CORS, which a background fetch bypasses entirely)
 *    rejects that by default with a 403, regardless of host_permissions.
 *    - **If Ollama is already running as a background app/tray icon/Windows service** (the common
 *      case — `ollama serve` in a fresh terminal will just fail with "address already in use"
 *      because that instance is already bound to the port): setting `$env:OLLAMA_ORIGINS` in a new
 *      terminal does NOT reach the already-running process. Set it as a persistent user environment
 *      variable instead, then restart Ollama (quit the tray icon, relaunch):
 *        [System.Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS', '*', 'User')
 *      (or System Properties → Environment Variables → New, same effect — either way, Ollama must
 *      be fully restarted afterward to pick it up).
 *    - **If you start it yourself**: `OLLAMA_ORIGINS=* ollama serve` (PowerShell:
 *      `$env:OLLAMA_ORIGINS='*'; ollama serve`).
 *    A failure here surfaces as `ai.ask: ollama responded 403 Forbidden: ...` from check 1 below —
 *    if instead you see `FAILED ... {}` with no message at all, that was a real bug in the Dry Run
 *    console relay (JSON.stringify(someError) is `'{}'` — fixed in dry-run-shim.ts; update the
 *    extension build and re-run to see the actual message).
 *
 * 3. Upload this script via the popup, Grant `net.request` for `http://localhost:11434/*` when
 *    prompted (`ai.ask` is gated on `net.request`'s own scope+match, not a scope of its own — see
 *    `kernel/scopes.ts`'s `ai.ask` entry for why), then load any page and open THAT tab's own
 *    DevTools console (not the service worker's) to see `run()`'s `console.log` output — or use
 *    Studio's "Run once on this tab" (Dry Run), whose console panel now shows Error messages
 *    correctly too.
 */
const MODEL = 'llama3.1:8b'; // swap for whatever `ollama list` shows you have pulled

__synapseModule = {
  id: 'ai-ask-test',
  scopes: [{ scope: 'net.request', match: ['http://localhost:11434/*'] }],
  async run(input, ctx) {
    // 1. Happy path: default Ollama endpoint, no secretRef (local server, no auth).
    try {
      const result = await ctx.api.ai.ask({
        provider: 'ollama',
        model: MODEL,
        messages: [{ role: 'user', content: 'Reply with exactly one word: hello' }],
      });
      console.log('[ai.ask] 1) OK — reply text:', JSON.stringify(result.text));
    } catch (err) {
      console.error('[ai.ask] 1) FAILED (expected this to succeed)', err);
    }

    // 2. A baseUrl that falls OUTSIDE this script's granted net.request match must be rejected —
    //    same fail-closed boundary net.request itself enforces, since ai.ask reuses that scope.
    try {
      await ctx.api.ai.ask({
        provider: 'ollama',
        baseUrl: 'http://localhost:9999/api/chat',
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      });
      console.error('[ai.ask] 2) FAILED: expected a match-pattern rejection, the call succeeded instead');
    } catch (err) {
      console.log('[ai.ask] 2) OK — rejected as expected (baseUrl outside granted match):', err.message);
    }

    // 3. Missing/empty messages is a client-side validation error, not a network call.
    try {
      await ctx.api.ai.ask({ provider: 'ollama', model: MODEL, messages: [] });
      console.error('[ai.ask] 3) FAILED: expected a validation rejection, the call succeeded instead');
    } catch (err) {
      console.log('[ai.ask] 3) OK — rejected as expected (empty messages):', err.message);
    }
  },
};

/**
 * OpenAI variant (needs a Dashboard secret first — same prerequisite as test-secrets.js: popup →
 * gear icon on "Secrets" → "+ Add secret", name `my-openai-key`, value your real API key,
 * allowedHost `https://api.openai.com/*`). Swap the module above for this shape to try it:
 *
 *   __synapseModule = {
 *     id: 'ai-ask-test-openai',
 *     scopes: [{ scope: 'net.request', match: ['https://api.openai.com/*'] }, 'secrets.use'],
 *     async run(input, ctx) {
 *       const result = await ctx.api.ai.ask({
 *         provider: 'openai',
 *         model: 'gpt-4o-mini',
 *         messages: [{ role: 'user', content: 'Reply with exactly one word: hello' }],
 *         secretRef: 'my-openai-key',
 *       });
 *       console.log('[ai.ask openai] reply:', result.text);
 *     },
 *   };
 *
 * Grant BOTH `net.request` and `secrets.use` when prompted — same two-consent-line shape
 * test-secrets.js's check 4 documents for net.request itself.
 */
