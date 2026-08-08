/**
 * Test server for the question blocking `iframe-unsandbox`'s retirement:
 *
 *   Does extension-style script injection (MAIN world AND isolated world) still run inside a
 *   document that a `Content-Security-Policy: sandbox` RESPONSE HEADER has sandboxed?
 *
 * If yes, the pub/sub architecture reaches those frames and the blanket CSP-stripping DNR rule is
 * unnecessary. If no, there is nothing inside the frame to run the publisher, and retiring the
 * module means genuinely losing detection in those frames.
 *
 * Five frame variants, so the answer is separable:
 *   A normal                      control
 *   B sandbox attribute           parent-side, no allow-scripts
 *   C sandbox="allow-scripts"     parent-side, scripts permitted
 *   D CSP: sandbox                response header, no allow-scripts  <-- THE CASE IN QUESTION
 *   E CSP: sandbox allow-scripts  response header, scripts permitted
 *
 * ANSWERED 2026-08-06 via Playwright + CDP (see docs/LESSONS.md, "Sandbox chặn script của TRANG,
 * không chặn injection của extension"): sandbox blocks the FRAME'S OWN scripts but blocks neither
 * MAIN-world nor ISOLATED-world injection, and `CustomEvent` still bridges the two. That is what
 * retired `iframe-unsandbox`'s blanket CSP-stripping DNR rule.
 *
 * USAGE
 *   node docs/examples/iframe-sandbox-test-page.cjs   then open http://localhost:8899/
 *
 * Still worth re-running by hand with the REAL extension loaded: the automated probe used CDP's
 * `Page.createIsolatedWorld`, which is the primitive content scripts are built on but is not the
 * extension injection path itself. What is unverified is whether Chrome CHOOSES to match a
 * content script into an opaque-origin sandboxed frame -- a policy question, not a capability one.
 * With network-sniffer active, frames B/D should still report their <video> elements.
 *
 * Each frame now serves a real `<video src>` pointing at a same-origin `/media/<label>.mp4` (a
 * tiny non-playable stub, just enough to trigger both DOM detection and a webRequest hit) -- an
 * earlier version of this harness had no <video> at all, so a "frame didn't report" result was
 * not distinguishable from "there was nothing to detect."
 */
const http = require('node:http');

const PORT = 8899;

const framePage = (label) => `<!doctype html>
<html><head><title>frame-${label}-initial</title></head>
<body>
  <h1 id="marker">frame ${label}</h1>
  <video src="/media/${label}.mp4" controls></video>
  <script>
    window.__pageJsRan = true;
    document.title = 'frame-${label}-JS-RAN';
  </script>
</body></html>`;

// Minimal stub bytes -- enough for a webRequest hit and a real HTTP response; not a playable file.
const FAKE_MP4_BYTES = Buffer.from('00000018667479706d703432000000006d703432', 'hex');

const parentPage = `<!doctype html>
<html><head><title>csp-sandbox-harness</title></head>
<body>
  <h1>iframe sandbox / CSP harness</h1>
  <iframe id="A" src="/frame/A"></iframe>
  <iframe id="B" src="/frame/B" sandbox></iframe>
  <iframe id="C" src="/frame/C" sandbox="allow-scripts"></iframe>
  <iframe id="D" src="/frame/D-csp-sandbox"></iframe>
  <iframe id="E" src="/frame/E-csp-sandbox-allow-scripts"></iframe>
  <script>window.__parentJsRan = true;</script>
</body></html>`;

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';

  if (url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(parentPage);
  }

  if (url === '/frame/A') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(framePage('A'));
  }
  if (url === '/frame/B') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(framePage('B'));
  }
  if (url === '/frame/C') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(framePage('C'));
  }
  // THE case: the framed document's own response sandboxes itself.
  if (url === '/frame/D-csp-sandbox') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': 'sandbox',
    });
    return res.end(framePage('D'));
  }
  if (url === '/frame/E-csp-sandbox-allow-scripts') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': 'sandbox allow-scripts',
    });
    return res.end(framePage('E'));
  }

  const mediaMatch = /^\/media\/([A-E])\.mp4$/.exec(url);
  if (mediaMatch) {
    res.writeHead(200, { 'content-type': 'video/mp4' });
    return res.end(FAKE_MP4_BYTES);
  }

  res.writeHead(404).end('not found');
});

server.listen(PORT, () => console.log(`harness on http://localhost:${PORT}/`));
