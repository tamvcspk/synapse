globalThis.__synapseModule = {
  id: 'media-test',
  scopes: ['media'],
  async run(input, ctx) {
    try {
      const found = await ctx.api.media.list();
      console.log('[media] list() ->', found.length, 'entr(y/ies)', found);

      if (found.length === 0) {
        console.log(
          '[media] Nothing detected yet on this page/session. Navigate to a page that plays video or ' +
            'audio (or an HLS stream), wait a few seconds for the network sniffer to see a request, ' +
            'then reload this page to re-run this script.',
        );
        return;
      }

      const master = found.find((m) => m.variants && m.variants.length > 0);
      if (master) {
        const variant = master.variants[0];
        const inspected = await ctx.api.media.inspect(variant.url);
        console.log('[media] inspect() on first variant of a master playlist ->', variant.url, inspected);
      } else {
        const stream = found.find((m) => m.kind === 'stream');
        if (stream) {
          const inspected = await ctx.api.media.inspect(stream.url);
          console.log('[media] inspect() on a standalone stream entry ->', stream.url, inspected);
        }
      }

      // Downloads the FIRST detected entry — fine for a manual smoke test, but note this writes a
      // real file to your Downloads folder. Comment out this block if you only want to exercise
      // list()/inspect() without triggering an actual download.
      const target = found[0];
      const jobId = await ctx.api.media.download({ url: target.url });
      console.log('[media] download() started, jobId =', jobId, 'for', target.url);

      let status;
      const deadline = Date.now() + 5 * 60 * 1000; // give up polling after 5 minutes either way
      do {
        await new Promise((r) => setTimeout(r, 1000));
        status = await ctx.api.media.job(jobId);
        console.log('[media] job() ->', status);
      } while (status && status.phase !== 'done' && status.phase !== 'error' && status.phase !== 'cancelled' && Date.now() < deadline);

      if (!status) {
        console.log('[media] job() returned undefined — either the background service worker restarted, or the job never started. See docs/api-inventory.md §3.1.');
      } else if (status.phase === 'done') {
        console.log('[media] download finished — check your Downloads folder.');
      } else if (status.phase === 'error') {
        console.error('[media] download failed:', status.error);
      }

      // Uncomment to try control() once a job is running (e.g. from a second script run while the
      // first is still in progress):
      // await ctx.api.media.control(jobId, 'pause');
      // await ctx.api.media.control(jobId, 'resume');
      // await ctx.api.media.control(jobId, 'cancel');
    } catch (err) {
      console.error('[media] FAILED', err);
    }
  },
};
