__synapseModule = {
  id: 'net-request-test',
  scopes: [{ scope: 'net.request', match: ['https://example.com/*'] }],
  async run(input, ctx) {
    try {
      const res = await ctx.api.net.request({ url: 'https://other-site.com/' });
      console.log('[net.request] OK', res.status, res.headers['content-type'], res.body.length, 'bytes');
    } catch (err) {
      console.error('[net.request] FAILED', err);
    }
  },
};
