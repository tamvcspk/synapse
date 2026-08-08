__synapseModule = {
  id: 'storage-lifetime-test',
  scopes: ['storage.rw'],
  async run(input, ctx) {
    try {
      const permanentBefore = await ctx.api.storage.get('permanent-counter');
      const sessionBefore = await ctx.api.storage.session.get('session-counter');
      const tabBefore = await ctx.api.storage.tab.get('tab-counter');

      const permanentAfter = (permanentBefore ?? 0) + 1;
      const sessionAfter = (sessionBefore ?? 0) + 1;
      const tabAfter = (tabBefore ?? 0) + 1;

      await ctx.api.storage.set('permanent-counter', permanentAfter);
      await ctx.api.storage.session.set('session-counter', sessionAfter);
      await ctx.api.storage.tab.set('tab-counter', tabAfter);

      console.log(
        `[storage-lifetime] permanent=${permanentAfter} (was ${permanentBefore ?? '<unset>'}), ` +
          `session=${sessionAfter} (was ${sessionBefore ?? '<unset>'}), ` +
          `tab=${tabAfter} (was ${tabBefore ?? '<unset>'})`,
      );
      console.log(
        '[storage-lifetime] How to read this on each reload:\n' +
          '  1. RELOAD THIS PAGE (same URL, e.g. Ctrl+R) → expect permanent+1, session BACK TO 1, tab+1.\n' +
          '     (session resets because a reload is a navigation commit — Track A1/A2.)\n' +
          '  2. Navigate to a DIFFERENT URL then back → same expectation as reload (session resets, tab does not).\n' +
          '  3. Switch to ANOTHER tab and back to THIS one (no reload) → expect ALL THREE unchanged\n' +
          '     until you interact with the page again (this script only runs once per navigation).\n' +
          '  4. CLOSE this tab, open a fresh tab to the same URL → expect permanent+1, session=1, TAB BACK TO 1.\n' +
          '     (tab resets because the tab it belonged to no longer exists — Track A2.)\n' +
          '  5. permanent NEVER resets on its own — only ctx.api.storage.remove(...) would clear it.',
      );
    } catch (err) {
      console.error('[storage-lifetime] FAILED', err);
    }
  },
};
