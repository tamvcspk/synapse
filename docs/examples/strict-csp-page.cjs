/**
 * Serves one page with a REAL `Content-Security-Policy: style-src 'self'` response header, for
 * verifying docs/ROADMAP.md §11.4's remaining condition: in-page UI must render **styled** on a site
 * that forbids inline styles.
 *
 *     node docs/examples/strict-csp-page.cjs      # → http://localhost:8787
 *
 * Why this file has to exist rather than testing on a real site: every well-known site measured so
 * far keeps `'unsafe-inline'` in `style-src` (docs/LESSONS.md), so `<style>` works there and the
 * failure mode never appears. And why a header rather than a `<meta http-equiv>` tag: the extension
 * ships against real response headers, and meta-delivered CSP applies slightly later in page
 * lifecycle — close enough to mislead, not close enough to trust.
 *
 * `style-src 'self'` with no `'unsafe-inline'` is the whole point. `script-src` is left permissive:
 * this page is testing the STYLE path, and locking scripts down too would just stop the page's own
 * marker script from running and muddy the result.
 *
 * What to look for once synapse-ui-a.js and synapse-ui-b.js are uploaded and this page is open:
 *   - The red "control" box below must be UNSTYLED (plain text, no red). That proves the CSP is
 *     really in force — if it renders red, the header is not doing what this page claims and any
 *     conclusion drawn here is worthless. Check this FIRST.
 *   - The Synapse icons top-right must be round dark circles that grow on hover, and the toasts
 *     bottom-right must be dark rounded cards. Unstyled-but-present is the FAILURE this page exists
 *     to catch: the widgets do not disappear under a strict CSP, they lose their appearance.
 */

const http = require('node:http');

const PORT = 8787;

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Synapse — strict style-src test page</title>
</head>
<body>
  <h1>Synapse strict-CSP test page</h1>
  <p>Served with <code>Content-Security-Policy: style-src 'self'</code> — no <code>'unsafe-inline'</code>.</p>

  <h2>Control</h2>
  <p>The box below is styled with an inline <code>&lt;style&gt;</code> block. Under this page's CSP
     the browser must drop it, so the box should look like ordinary text on a white background.
     <strong>If it is red, the CSP is not in force and this page proves nothing.</strong></p>
  <style>
    #control { background: #c00; color: #fff; padding: 12px; border-radius: 8px; font-weight: bold; }
  </style>
  <div id="control">If this is red, STOP — the CSP is not applying.</div>

  <h2>What to check</h2>
  <ul>
    <li>Synapse icons (top-right): round dark circles, and they scale up on hover.</li>
    <li>Synapse toasts (bottom-right): dark rounded cards with a blue action link.</li>
    <li>Unstyled-but-visible widgets = failure. That is exactly what this page is for.</li>
  </ul>

  <h2>Something to anchor a badge to</h2>
  <p>The badge (★) must sit at this image's top-left corner and <strong>stay there while you
     scroll</strong> — the page is deliberately tall enough to scroll for that reason. The id is
     what synapse-ui-b.js looks for; without it the fixture falls back to the first sizeable element,
     which in document order is the <code>&lt;h1&gt;</code> above.</p>
  <img id="badge-target" src="data:image/svg+xml;utf8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#345"/><text x="160" y="96" font-size="20" fill="#fff" text-anchor="middle">badge target</text></svg>',
  )}" width="320" height="180" alt="badge target">

  <h2>Scroll runway</h2>
  <p>Scroll down and back. The badge must track the image; the icons and toasts must not move at
     all (they are viewport-fixed, not document-anchored). Once the image scrolls out of view the
     badge should hide, and reappear on the way back.</p>
  ${'<p>Filler line so the document scrolls.</p>\n  '.repeat(60)}
  <p><em>End of runway.</em></p>
</body>
</html>`;

http
  .createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      // The one header this file exists for. No 'unsafe-inline'.
      'Content-Security-Policy': "style-src 'self'",
      'Cache-Control': 'no-store',
    });
    res.end(PAGE);
  })
  .listen(PORT, () => {
    console.log(`Strict-CSP test page: http://localhost:${PORT}`);
    console.log("Header: Content-Security-Policy: style-src 'self'");
  });
