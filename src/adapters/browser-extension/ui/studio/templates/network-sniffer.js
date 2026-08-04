/**
 * TEMPLATE — starting point for a "find media on this page" script (docs/ROADMAP.md §12.4).
 *
 * What this does TODAY:
 * - Scans <video>/<audio> elements ALREADY RENDERED on the page (and their <source> children) for
 *   a `src`/`currentSrc` — `page.dom` is Disclosed, no `ctx.api` call needed to read them.
 * - Saves the list under this script's own `storage.rw` namespace and logs it.
 *
 * What it CANNOT do, compared to the builtin "Media Sniffer":
 * - No network-level detection. The builtin also watches `chrome.webRequest` (catches a manifest
 *   URL fetched by JS that never becomes a `<video src>` — e.g. a player that feeds MediaSource
 *   buffers directly) and elements inside cross-origin iframes. Neither is reachable from a user
 *   script today: there is no `net.observe`-shaped subscription scope (a script can only ask/answer
 *   once per call — a live stream of "a request just happened" events has nowhere to land on the
 *   current `ctx.api` transport, docs/ROADMAP.md §11.3), and cross-origin iframe content is
 *   invisible to `document.querySelector` from the top frame for the same reason it's invisible to
 *   any other page script.
 * - No download step. Even a URL this template finds still has to be opened/downloaded by hand —
 *   the builtin's HLS pool/remux/pause-resume download engine has no scope exposing it to scripts.
 *
 * Missing scope for full parity: a subscription-shaped `net.observe` (or similar) — an open point in
 * docs/ROADMAP.md, not designed yet.
 */
__synapseModule = {
  id: 'media-sniffer-lite',
  scopes: ['storage.rw'],

  async run(input, ctx) {
    const found = [];
    for (const el of document.querySelectorAll('video, audio')) {
      const urls = new Set();
      if (el.currentSrc) urls.add(el.currentSrc);
      if (el.getAttribute('src')) urls.add(new URL(el.getAttribute('src'), location.href).toString());
      for (const source of el.querySelectorAll('source')) {
        if (source.getAttribute('src')) urls.add(new URL(source.getAttribute('src'), location.href).toString());
      }
      for (const url of urls) found.push({ kind: el.tagName.toLowerCase(), url });
    }

    await ctx.api.storage.set('last-scan', found);
    console.log(`Found ${found.length} media element(s):`, found);
    return found;
  },
};
