/**
 * Manual browser test for Secret Service (docs/ROADMAP.md §11.6 — implemented, CHƯA verify bằng
 * browser thật; this script is that verification).
 *
 * PREREQUISITE — create the secret FIRST. There is no script API to create one (by design, see
 * §11.6's "Ba luật dạng không có" — secret management is Dashboard UI-only). Open the popup → gear
 * icon on "Secrets" (opens the Dashboard) → "+ Add secret":
 *   name:        synapse-test-secret
 *   value:       anything, e.g. hello-from-synapse   (this script never gets to read or choose it)
 *   allowedHost: https://postman-echo.com/*
 * Save, THEN upload this script.
 *
 * Upload via the popup, Grant BOTH `net.request` and `secrets.use` when prompted (two separate
 * consent lines — see check 4 below for what happens if you only grant one), load any page (this
 * script's own tab doesn't need to be on postman-echo.com — net.request runs in the background
 * regardless of the page you're on), then open THAT tab's OWN DevTools (F12) and switch the console
 * context dropdown (top-left, next to "top") to this script's own context — `console.log` from
 * `run()` shows up there, NOT in the service worker console and NOT under "top" (docs/LESSONS.md:
 * "khi hướng dẫn verify qua console tay, phải nêu ĐÚNG world/context" — there are 3 separate
 * consoles; this is the one `run()`'s own logs use).
 *
 * Why postman-echo.com/headers: it echoes back every header it received, in the JSON response body
 * — the one honest way to confirm the platform actually substituted the secret into the OUTGOING
 * request, without this script ever calling anything that returns the secret itself (there is no
 * such call — `ctx.api.secrets` does not exist). Reading it back off a normal HTTP response is not
 * a hole in "the script never sees the secret" — it's what any response legitimately contains once
 * you make a real call, same as checking whether a third-party API actually received your
 * Authorization header.
 */
__synapseModule = {
  id: 'secrets-test',
  scopes: [
    // example.com is included here on purpose, for check 3 below: it needs to be inside THIS
    // script's own net.request grant so that check isolates the secret's *own* allowedHost binding
    // (postman-echo.com only) rather than just re-proving the ordinary net.request match check.
    { scope: 'net.request', match: ['https://postman-echo.com/*', 'https://example.com/*'] },
    'secrets.use',
  ],
  async run(input, ctx) {
    // 1. Happy path: secretRef resolves, format is applied, request reaches the allowed host.
    try {
      const res = await ctx.api.net.request({
        url: 'https://postman-echo.com/headers',
        headers: { 'x-synapse-secret-test': { secretRef: 'synapse-test-secret', format: 'token {}' } },
      });
      const echoed = JSON.parse(res.body).headers['x-synapse-secret-test'];
      console.log('[secrets] 1) net.request OK, status', res.status, '— server echoed the header back as:', JSON.stringify(echoed));
      console.log(
        echoed && echoed.indexOf('token ') === 0
          ? '[secrets] 1) OK — the platform substituted the secret and applied format "token {}".'
          : '[secrets] 1) MISMATCH — expected "token <value>", see the echoed value above.',
      );
    } catch (err) {
      console.error('[secrets] 1) FAILED (expected this to succeed)', err);
    }

    // 2. A plain string header alongside a secretRef one is left untouched.
    try {
      const res = await ctx.api.net.request({
        url: 'https://postman-echo.com/headers',
        headers: {
          'x-synapse-secret-test': { secretRef: 'synapse-test-secret' },
          'x-synapse-plain-test': 'untouched-value',
        },
      });
      const echoed = JSON.parse(res.body).headers['x-synapse-plain-test'];
      console.log(
        '[secrets] 2)',
        echoed === 'untouched-value' ? 'OK — plain string header passed through unchanged:' : 'MISMATCH:',
        JSON.stringify(echoed),
      );
    } catch (err) {
      console.error('[secrets] 2) FAILED (expected this to succeed)', err);
    }

    // 3. The secret's OWN allowedHost is checked independently of this call's net.request match —
    //    example.com falls under this script's net.request grant (see scopes above) but NOT under
    //    the secret's allowedHost (https://postman-echo.com/*), so this must still be denied.
    try {
      await ctx.api.net.request({
        url: 'https://example.com/',
        headers: { 'x-synapse-secret-test': { secretRef: 'synapse-test-secret' } },
      });
      console.error('[secrets] 3) FAILED: expected a host-mismatch rejection, the call succeeded instead');
    } catch (err) {
      console.log('[secrets] 3) OK — rejected as expected (secret is bound to a different host):', err.message);
    }
  },
};

/**
 * Two more checks that need a state change this single run() can't produce on its own:
 *
 * 4. **Missing `secrets.use`.** DO NOT just delete `'secrets.use'` from `scopes` above and Save on
 *    top of this same script — editing a script in Studio REHASHES its existing grant against the
 *    new source but never revokes anything already granted (docs/ROADMAP.md §12.2: "Grant KHÔNG bị
 *    hỏi lại... sửa trong Studio thì grant cũ được rehash theo source mới, không bị xoá" — only
 *    WIDENING `scopes` re-prompts). Editing-in-place leaves the OLD `secrets.use` grant sitting in
 *    storage untouched, so check 1 keeps passing even though the source "looks like" it no longer
 *    asks for it — this is not a bug, it just isn't the state this check needs (docs/LESSONS.md has
 *    the full note). Instead: **delete this script from the popup (🗑️) first**, THEN re-upload it
 *    with `'secrets.use'` removed from `scopes` — a fresh upload gets a brand-new grant record with
 *    no `secrets.use` in it at all. Grant only `net.request` when prompted, load the test page.
 *    Expect check 1 to now reject with `Scope "secrets.use" is not granted for module
 *    "secrets-test"` — `net.request` alone is not enough once a call's headers reference a secret.
 *    Re-add `'secrets.use'` and repeat the delete+re-upload afterward to restore the full test.
 *
 * 5. **Editing the secret keeps the value when you leave it blank.** In the Dashboard's Secrets
 *    panel, open "synapse-test-secret" for edit, change only `allowedHost` (or nothing), leave the
 *    Value field BLANK, and Save. The Value column should still show `••••••••`, and re-running
 *    this script (check 1) should still succeed with the ORIGINAL value — a blank Value on an edit
 *    means "keep the current value", not "clear it".
 */
