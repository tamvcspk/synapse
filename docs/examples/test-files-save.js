globalThis.__synapseModule = {
  id: 'files-save-test',
  scopes: ['files.save'],
  async run(input, ctx) {
    try {
      const res = await ctx.api.files.save({
        filename: 'synapse-test/hello.txt',
        content: `hello from synapse files.save, ${new Date().toISOString()}`,
      });
      console.log('[files.save] OK, downloadId', res.downloadId);
    } catch (err) {
      console.error('[files.save] FAILED', err);
    }
  },
};
