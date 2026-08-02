globalThis.__synapseModule = {
  id: 'lib-hls-parse-test',
  // No scopes needed — lib.* is unscoped by design.
  async run(input, ctx) {
    try {
      const text = [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXTINF:6.0,',
        'segment0.ts',
        '#EXTINF:6.0,',
        'segment1.ts',
        '#EXT-X-ENDLIST',
      ].join('\n');
      const manifest = ctx.api.lib.hls.parse(text, 'https://example.com/stream/index.m3u8');
      console.log('[lib.hls.parse] OK', manifest.kind, manifest.segments?.length, 'segments', manifest.segments?.[0]?.url);
    } catch (err) {
      console.error('[lib.hls.parse] FAILED', err);
    }
  },
};
