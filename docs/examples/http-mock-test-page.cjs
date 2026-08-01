/**
 * Local test server + page for verifying `http-error-mocker` (docs/ROADMAP.md #2.6/#2.6.1/§11.5)
 * end-to-end against a real origin, across all 3 mechanisms (`main-world`/`debugger`/`dnr`) and all
 * 3 actions (`fake-response`/`rewrite-request`/`block`).
 *
 *     node docs/examples/http-mock-test-page.cjs      # → http://localhost:8788
 *
 * Why this file has to exist rather than testing against a real site: every button below hits an
 * endpoint on THIS server that answers for real (marked `"source":"real-server"` in every JSON
 * reply, or a real PNG for the image endpoint) — so with no mock rule active, every button must
 * show the real answer, and the moment a rule is added in the Dashboard the SAME button's result
 * visibly changes. Without a controllable real baseline to diff against, "did the mock actually do
 * anything" is a guess; with one, it's a glance. A real site's own endpoints can't offer that
 * baseline (you don't know what they'd say without the mock either) and can't be used to test
 * `action: 'block'` safely (only `/api/block-me` here is meant to fail).
 *
 * How to use: open the page, add mock rules in the Dashboard (Module → HTTP Mock & Rewrite) with
 * `endpointPattern` like `*<something>` matching one of the paths printed on the page, then click
 * the matching button and compare against the "real answer" shown next to it. Toggle the rule
 * off/on and click again — the result must flip back and forth.
 *
 * Two things that LOOK like bugs but aren't:
 *   - `fetch() THREW: TypeError: Failed to fetch` on a `rewrite-request` rule whose `rewriteUrl`
 *     points at a genuinely different origin (not this server) is normal CORS behavior — the
 *     interceptor patches the CALL, but the actual network fetch to that foreign origin is still a
 *     real browser fetch, still bound by whatever CORS headers (or lack of them) that origin sends.
 *     Pick a `rewriteUrl` on THIS server (e.g. `/api/get`) to test URL-rewrite without CORS noise.
 *   - A `dnr` rule that appears to do nothing: `dnr` has no live JS callback (utils/dnr-network-rules.ts)
 *     — the fastest way to check whether Chrome actually registered/matched it is the extension's
 *     own service-worker console (chrome://extensions → Synapse → "service worker" link):
 *     `chrome.declarativeNetRequest.getDynamicRules().then(r => console.log(JSON.stringify(r, null, 2)))`
 *     — confirms the rule exists, and shows its exact `condition`/`action` (a wrong `regexFilter` or
 *     `requestMethods` is the most common reason a rule silently never matches).
 *   - A mock that "keeps affecting requests" even after removing the rule: every GET button below
 *     now busts the HTTP cache on purpose (a `_=timestamp` query param + `cache:'no-store'`) —
 *     WITHOUT that, re-clicking the same button hits the SAME url every time, and the browser is
 *     free to answer straight from cache with zero network request. That looked identical to a
 *     lingering DNR rule (a `data:` URL redirect answers before the request ever reaches this
 *     server, so this server's own `Cache-Control: no-store` header on `/api/image.png` never gets
 *     a chance to apply to whatever the browser cached for that redirect). If you're editing this
 *     file to add a new button, copy `bust()` — don't hit a static path a second time.
 *
 * What each button is FOR (mechanism/action combinations that only some paths can reach):
 *   - GET /api/get        → plain `fake-response` sanity check. Works on all 3 mechanisms.
 *   - POST /api/post      → `rewrite-request` on body/headers. `main-world`/`debugger` ONLY — `dnr`
 *     cannot rewrite a body (validateMockConfig rejects that combo), so a `dnr` rule here should
 *     fail to save in the Dashboard, not fail silently here.
 *   - GET /api/method-echo → `rewrite-request` on METHOD (GET→POST). Same `main-world`/`debugger`
 *     only restriction as above — proves the rewrite reached the real network layer (the endpoint's
 *     OWN reply says which method it actually received), not just a client-side illusion.
 *   - GET /api/image.png as <img> tag → only `debugger`/`dnr` can intercept this at all — it's not a
 *     fetch()/XHR call, so `main-world`'s patch (which only wraps window.fetch/XMLHttpRequest) never
 *     sees it. A `main-world` rule targeting this path should have ZERO effect on the <img>, while
 *     still affecting the "fetch the same URL" button below it.
 *   - GET /api/image.png via fetch() → exercises docs/ROADMAP.md §2.6.1's still-unverified path:
 *     upload a small binary file as `fakeResponseFile` (mechanism: debugger) or use the inline path
 *     (mechanism: main-world) and confirm the rendered <img> is pixel-correct, not corrupted — this
 *     is the concrete browser test that Open Point has been waiting on. Byte length + first bytes
 *     (hex) are printed alongside the image so silent corruption that still LOOKS like an image
 *     (wrong colors, truncated) is still visible as a length/hex mismatch.
 *   - GET /api/xhr-only    → same as /api/get but deliberately fetched via XMLHttpRequest, not
 *     fetch() — main-world's interceptor patches the two independently (network-interceptor.ts), so
 *     a rule that works on fetch() is not proof it works on XHR too.
 *   - GET /api/block-me    → `action: 'block'` sanity check. Requires `mechanism: 'debugger'` or
 *     `'dnr'` (validateMockConfig rejects `block` + `main-world`). Unmocked, this endpoint always
 *     succeeds with 200 — if a block rule is active it must show a network-level failure (a rejected
 *     fetch/XHR), not just a fake error body.
 *   - GET /api/slow        → `delayMs` sanity check. The server answers immediately; the page times
 *     the round trip client-side, so a rule with `delayMs: 2000` should make the reported time jump
 *     by ~2s regardless of mechanism.
 *
 * Every JSON endpoint deliberately includes `"source":"real-server"` so a fake-response rule's own
 * body is trivially distinguishable from the real one at a glance, without memorizing anything.
 */

const http = require('node:http');

const PORT = 8788;

// A real, tiny, valid PNG (2x2, opaque green) — deliberately NOT a 1x1 pixel, so a corrupted decode
// (wrong dimensions, truncated IDAT) is more likely to visibly fail to render instead of silently
// still looking like a valid dot.
const REAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR42mNkYPhfz0AEYBxVSF+FAAhKAgumsvW3AAAAAElFTkSuQmCC',
  'base64',
);

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Synapse — http-error-mocker test page</title>
  <style>
    body { font: 14px/1.5 system-ui, sans-serif; max-width: 780px; margin: 24px auto; padding: 0 16px; }
    button { display: block; margin: 6px 0; padding: 6px 12px; cursor: pointer; }
    pre { background: #f4f4f4; padding: 8px; border-radius: 6px; white-space: pre-wrap; word-break: break-all; max-height: 220px; overflow: auto; }
    .row { border: 1px solid #ddd; border-radius: 8px; padding: 10px 14px; margin: 14px 0; }
    .path { color: #666; font-family: monospace; }
    img.result { max-width: 96px; image-rendering: pixelated; border: 1px solid #ccc; vertical-align: middle; }
  </style>
</head>
<body>
  <h1>http-error-mocker test page</h1>
  <p>Server is real — every reply below is genuine unless a mock rule in the Dashboard intercepts it.
     Add/toggle rules under <strong>Module → HTTP Mock &amp; Rewrite</strong>, then click a button
     again. See this file's header comment for exactly what each row is designed to catch.</p>

  <div class="row">
    <span class="path">GET /api/get</span> — fake-response sanity check (all mechanisms)
    <button onclick="doFetch('GET', '/api/get', 'get')">Fetch</button>
    <pre id="get"></pre>
  </div>

  <div class="row">
    <span class="path">POST /api/post</span> — rewrite-request body/headers (main-world/debugger only)
    <button onclick="doPost('/api/post', 'post')">Fetch (POST, body: hello-from-page)</button>
    <pre id="post"></pre>
  </div>

  <div class="row">
    <span class="path">GET /api/method-echo</span> — rewrite-request METHOD GET→POST (main-world/debugger only)
    <button onclick="doFetch('GET', '/api/method-echo', 'method-echo')">Fetch (GET)</button>
    <pre id="method-echo"></pre>
  </div>

  <div class="row">
    <span class="path">GET /api/image.png</span> — binary correctness (§2.6.1 open point) + non-fetch resource type
    <div>
      <button onclick="doImgTag()">Load as &lt;img&gt; (debugger/dnr only can intercept this)</button>
      <img id="img-tag-result" class="result" alt="(not loaded yet)">
    </div>
    <div>
      <button onclick="doImageFetch()">Fetch as bytes (all mechanisms)</button>
      <img id="img-fetch-result" class="result" alt="(not loaded yet)">
    </div>
    <pre id="image"></pre>
  </div>

  <div class="row">
    <span class="path">GET /api/xhr-only</span> — same as /api/get, but via XMLHttpRequest, not fetch()
    <button onclick="doXhr('/api/xhr-only', 'xhr')">XHR GET</button>
    <pre id="xhr"></pre>
  </div>

  <div class="row">
    <span class="path">GET /api/block-me</span> — action: block (debugger/dnr only). Unmocked = always succeeds.
    <button onclick="doFetch('GET', '/api/block-me', 'block')">Fetch</button>
    <pre id="block"></pre>
  </div>

  <div class="row">
    <span class="path">GET /api/slow</span> — delayMs sanity check (server itself never delays)
    <button onclick="doTimed('/api/slow', 'slow')">Fetch (times the round trip)</button>
    <pre id="slow"></pre>
  </div>

  <script>
    function show(id, text) { document.getElementById(id).textContent = text; }

    // Every GET button below hits the SAME url on every click — without a cache-buster the browser
    // is free to answer a repeat click straight from its HTTP cache, no network request at all,
    // which looks EXACTLY like "the mock rule is still active" even after removing it in the
    // Dashboard (the response really is stale, just not because of anything DNR/debugger/main-world
    // did). cache:'no-store' on fetch() is the primary fix; the appended _=timestamp is a second
    // layer for the DNR case specifically - a data: URL redirect answers BEFORE the request ever
    // reaches this server, so this server's own Cache-Control: no-store response header (only sent
    // for the REAL /api/image.png reply) never has a chance to apply to whatever the browser cached
    // for that redirect.
    function bust(path) {
      return path + (path.includes('?') ? '&' : '?') + '_=' + Date.now();
    }

    async function doFetch(method, path, id) {
      try {
        const res = await fetch(bust(path), { method, cache: 'no-store' });
        const text = await res.text();
        show(id, 'status: ' + res.status + ' ' + res.statusText + '\\n\\n' + text);
      } catch (err) {
        show(id, 'fetch() THREW (this is what action: "block" should cause): ' + err);
      }
    }

    async function doPost(path, id) {
      try {
        const res = await fetch(path, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'X-Test-Header': 'original-value' },
          body: JSON.stringify({ marker: 'hello-from-page' }),
        });
        const text = await res.text();
        show(id, 'status: ' + res.status + '\\n\\n' + text);
      } catch (err) {
        show(id, 'fetch() THREW: ' + err);
      }
    }

    function doXhr(path, id) {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', bust(path));
      xhr.onload = () => show(id, 'status: ' + xhr.status + '\\n\\n' + xhr.responseText);
      xhr.onerror = () => show(id, 'XHR errored (this is what action: "block" should cause)');
      xhr.send();
    }

    async function doTimed(path, id) {
      const start = performance.now();
      try {
        const res = await fetch(bust(path), { cache: 'no-store' });
        const text = await res.text();
        const ms = Math.round(performance.now() - start);
        show(id, 'round trip: ' + ms + 'ms\\nstatus: ' + res.status + '\\n\\n' + text);
      } catch (err) {
        show(id, 'fetch() THREW: ' + err);
      }
    }

    function bytesToHex(buf, n) {
      return Array.from(new Uint8Array(buf).slice(0, n)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    }

    async function doImageFetch() {
      try {
        const res = await fetch(bust('/api/image.png?via=fetch'), { cache: 'no-store' });
        const buf = await res.arrayBuffer();
        // Blob + object URL, not a hand-built data: URL — btoa(String.fromCharCode(...bytes))
        // spreads one function-call argument PER BYTE, which throws "Maximum call stack size
        // exceeded" for anything bigger than a few tens of KB (exactly what a real uploaded test
        // image trips, unlike the tiny 78-byte built-in fixture). Blob has no such limit.
        const contentType = res.headers.get('content-type') || 'image/png';
        document.getElementById('img-fetch-result').src = URL.createObjectURL(new Blob([buf], { type: contentType }));
        show('image', 'fetch: status ' + res.status + ', ' + buf.byteLength + ' bytes, first 8: ' + bytesToHex(buf, 8));
      } catch (err) {
        show('image', 'fetch() THREW: ' + err);
      }
    }

    function doImgTag() {
      const img = document.getElementById('img-tag-result');
      img.onerror = () => show('image', '<img> tag FAILED to load (this is what action: "block" should cause, or a broken fake file)');
      img.onload = () => show('image', '<img> tag loaded — compare visually against the fetch()-as-bytes result above (both hit the same URL).');
      img.src = '/api/image.png?via=img-tag&t=' + Date.now();
    }
  </script>
</body>
</html>`;

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }

    if (url.pathname === '/api/get' && req.method === 'GET') {
      return json(res, 200, { ok: true, source: 'real-server', path: '/api/get' });
    }

    if (url.pathname === '/api/post' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, {
        ok: true,
        source: 'real-server',
        receivedMethod: req.method,
        // ALL headers, not a hardcoded subset — a rewrite rule adding a header with an arbitrary
        // NEW name (e.g. `{"test":"test"}`) is invisible if this only echoes back names it already
        // knew to look for.
        receivedHeaders: req.headers,
        receivedBody: body,
      });
    }

    if (url.pathname === '/api/method-echo' && (req.method === 'GET' || req.method === 'POST')) {
      return json(res, 200, { ok: true, source: 'real-server', receivedMethod: req.method });
    }

    if (url.pathname === '/api/image.png' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(REAL_PNG);
      return;
    }

    if (url.pathname === '/api/xhr-only' && req.method === 'GET') {
      return json(res, 200, { ok: true, source: 'real-server', path: '/api/xhr-only' });
    }

    if (url.pathname === '/api/block-me' && req.method === 'GET') {
      return json(res, 200, { ok: true, source: 'real-server', note: 'If you see this with a block rule active, the rule is NOT working.' });
    }

    if (url.pathname === '/api/slow' && req.method === 'GET') {
      return json(res, 200, { ok: true, source: 'real-server', note: 'Server answers instantly — any delay you see comes from delayMs.' });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  })
  .listen(PORT, () => {
    console.log(`http-error-mocker test page: http://localhost:${PORT}`);
  });
