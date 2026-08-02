__synapseModule = {
  id: 'lib-reader-mode-test',
  // net.request's match is broad here for a quick manual test — a real script should scope this to
  // the actual domains it expects to download images from, not '*://*/*'.
  scopes: [{ scope: 'net.request', match: ['*://*/*'] }, 'files.save'],
  async run(input, ctx) {
    try {
      const article = ctx.api.lib.readable();
      if (!article) {
        console.log('[reader-mode template] this page is not readerable');
        return;
      }

      const baseUrl = document.baseURI;
      const imgs = Array.from(article.root.querySelectorAll('img'));
      const urlToLocalPath = new Map();
      const zipEntries = [];

      for (let i = 0; i < imgs.length; i++) {
        const src = imgs[i].getAttribute('src');
        if (!src) continue;
        let absolute;
        try { absolute = new URL(src, baseUrl).toString(); } catch { continue; }
        if (urlToLocalPath.has(absolute)) continue;

        try {
          const res = await ctx.api.net.request({ url: absolute, responseType: 'arraybuffer' });
          if (res.status !== 200) continue;
          const ext = (absolute.split('.').pop() || 'bin').split(/[?#]/)[0].slice(0, 5);
          const localPath = `images/img-${i}.${ext}`;
          zipEntries.push({ name: localPath, data: base64ToBytes(res.body) });
          urlToLocalPath.set(absolute, localPath);
        } catch (err) {
          console.warn('[reader-mode template] image fetch failed', absolute, err);
        }
      }

      const markdown = ctx.api.lib.toMarkdown(article.root, {
        baseUrl,
        resolveImageUrl: (absoluteUrl) => urlToLocalPath.get(absoluteUrl) || absoluteUrl,
      });
      zipEntries.push({ name: 'article.md', data: new TextEncoder().encode(`# ${article.title}\n\n${markdown}`) });

      const zipBytes = ctx.api.lib.zip(zipEntries);
      const result = await ctx.api.files.save({
        filename: 'synapse-test/reader-mode-article.zip',
        content: bytesToBase64(zipBytes),
        contentEncoding: 'base64',
      });
      console.log('[reader-mode template] OK', JSON.stringify(article.title), zipEntries.length, 'zip entries, downloadId', result.downloadId);
    } catch (err) {
      console.error('[reader-mode template] FAILED', err);
    }
  },
};

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
