globalThis.__synapseModule = {
  id: 'lib-match-pattern-test',
  // No scopes needed — lib.* is unscoped by design.
  async run(input, ctx) {
    try {
      const cases = [
        ['https://api.example.com/*', 'https://api.example.com/users/1', true],
        ['https://api.example.com/*', 'https://api.other.com/users/1', false],
        ['*://*.example.com/*', 'https://sub.example.com/x', true],
        ['*://*.example.com/*', 'https://example.com.evil.com/x', false], // the exact case a substring-glob would get wrong
        ['*://*/*', 'ftp://example.com/x', false], // `*` scheme means http/https only, per Chrome's own rule
      ];

      let allOk = true;
      for (const [pattern, url, expected] of cases) {
        const isValid = ctx.api.lib.matchPattern.isValid(pattern);
        const result = ctx.api.lib.matchPattern.test(url, pattern);
        const ok = isValid && result === expected;
        allOk &&= ok;
        console.log(`[lib.matchPattern] ${ok ? 'OK' : 'FAIL'} test(${JSON.stringify(url)}, ${JSON.stringify(pattern)}) = ${result} (expected ${expected})`);
      }

      const testAny = ctx.api.lib.matchPattern.testAny('https://api.example.com/x', ['https://other.com/*', 'https://api.example.com/*']);
      console.log('[lib.matchPattern] testAny ->', testAny, testAny === true ? 'OK' : 'FAIL');

      console.log(ctx.api.lib.matchPattern.isValid('not-a-pattern') === false ? '[lib.matchPattern] OK isValid rejects garbage' : '[lib.matchPattern] FAIL isValid should reject garbage');

      console.log(allOk ? '[lib.matchPattern] ALL CASES OK' : '[lib.matchPattern] SOME CASES FAILED — see above');
    } catch (err) {
      console.error('[lib.matchPattern] FAILED', err);
    }
  },
};
