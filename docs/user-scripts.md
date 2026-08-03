# User Scripts

Synapse runs plain `.js` files you upload from the extension popup, Tampermonkey-style, without
rebuilding the extension. This is possible because Manifest V3's CSP blocks arbitrary
`eval`/dynamic `import()` in privileged contexts; the only sanctioned way to run user-supplied code
is [`chrome.userScripts`](https://developer.chrome.com/docs/extensions/reference/api/userScripts),
which executes your script in an isolated `USER_SCRIPT` world, separate from both the page and the
extension's own background/content-script contexts.

## Enabling uploads

Chrome requires you to allow this per install: open `chrome://extensions`, find Synapse, open its
details page, and enable **"Allow User Scripts"**. Without it, uploads register but your script can
never reach the extension's messaging bridge (`chrome.userScripts.configureWorld` fails in the
background — the popup shows a banner when this has happened).

## Writing a script

There's no bundler step for an uploaded file, so there's no `import`. Declare your script by
assigning one global; the platform hands you its API as `run()`'s second argument. Assign the bare
name, not `globalThis.__synapseModule` — both create the same global at runtime, but only the bare
form gets autocomplete/type-checking from `synapse-userscript.d.ts` in an editor (Monaco's `checkJs`
can't contextually type an assignment through `globalThis.`, see `docs/LESSONS.md`):

```javascript
__synapseModule = {
  id: 'reading-time',        // display label only — see "Identity"
  scopes: ['storage.rw'],    // permissions you're asking for; omit for none

  async run(input, ctx) {
    const words = document.body.innerText.trim().split(/\s+/).length;
    const minutes = Math.ceil(words / 220);

    const seen = (await ctx.api.storage.get('pages-measured')) ?? 0;
    await ctx.api.storage.set('pages-measured', seen + 1);

    console.log(`~${minutes} min read. Pages measured so far: ${seen + 1}`);
    return { minutes };
  },
};
```

### Multiple steps (pipeline)

A script grows past one logical stage by declaring `steps` instead of `run` — never both:

```javascript
__synapseModule = {
  id: 'crawl-and-summarize',
  scopes: ['storage.rw'],
  steps: [
    {
      id: 'load-dom',
      async run() {
        return document.body.innerText;
      },
    },
    {
      id: 'word-count',
      label: 'Count words',
      async run(text, ctx) {
        const words = text.trim().split(/\s+/).length;
        await ctx.api.storage.set('last-word-count', words);
        return words;
      },
    },
  ],
};
```

Steps run in array order, each one's return value becoming the next one's `input` — exactly the
bundled Composite Module pipeline (`createCompositeModule`) uses internally. Declaring `run` is
really shorthand for a single step named `'main'`; the platform normalizes it that way internally,
so every uploaded script is "a pipeline of N≥1 steps" from the extension's point of view.

- **`id` should be a literal string**, not one computed at runtime. Studio's Steps sidebar
  (docs/ROADMAP.md §12.3) locates a step's definition by searching your saved source for that exact
  quoted literal and scrolling the editor to it — an id built from a variable can still be listed
  there, just never jumped to.
- **No rollback.** A step that throws is recorded (Studio's sidebar shows which one and why, and the
  popup still shows the script as invalid with that reason) but does **not** stop the pipeline — the
  next step still runs, receiving whatever the previous SUCCESSFUL step returned.
- **Bypassing a step** is a Studio sidebar checkbox, not something your code controls — a bypassed
  step's input passes to the next step completely unchanged, as if it were never declared.
- **Two steps sharing one `id` is invalid**, same as declaring `run` and `steps` at once.

**`ctx.api` is the only handle — there is no `synapseApi` global.** Every uploaded script shares one
execution world, so a global name has a single binding for all of them and cannot tell the platform
which script is calling: the last script loaded would own it, and everyone else's calls would run
under *its* identity and *its* permissions. To use the API outside `run()` (from an event handler,
say), capture it:

```javascript
let api;
__synapseModule = {
  id: 'my-script',
  scopes: ['storage.rw'],
  async run(input, ctx) {
    api = ctx.api;
    document.addEventListener('click', () => api.storage.set('last-click', Date.now()));
  },
};
```

The name `synapseApi` does exist in that world, but every method on it rejects with that
explanation — a loud failure rather than a silent impersonation.

[`docs/types/synapse-userscript.d.ts`](types/synapse-userscript.d.ts) has the full surface with
per-scope and per-method notes; reference it in your editor for autocomplete (it's generated from
the extension's own source, so it can't drift out of date).

## Three rules that are not style preferences

Every call crosses `chrome.runtime.sendMessage`'s structured-clone boundary. Breaking these
produces **silent no-ops, not errors**:

1. **Every method is `async`** — always `await`.
2. **Never pass a function as an argument.** Functions don't survive the clone; they arrive as
   `undefined` and the call quietly does nothing.
3. **Returned values are plain data**, never objects with methods on them.

The same boundary is why anything you store must be clonable: no functions, no DOM nodes, no class
instances.

## Scopes and consent

A script declares what it wants to **do**, not which internal pipe it wants. Scopes come in two
kinds, and the extension shows them to you separately when it asks:

- **Enforced** — the only way to do it is through `ctx.api`, so denying it really does block the
  call. `storage.rw` is one.
- **Disclosed** — the script can do it anyway, with or without your approval. `page.dom` is the
  clearest case: a script sharing the page's DOM can call `document.querySelector` with zero
  permission from Synapse. Listing it is transparency, not a gate, and the popup says so rather
  than implying refusal protects you.

Declaring `scopes` is a **request**. The background service worker re-checks the grant you approved
on every single call — the script's own declaration is never authorization, and neither is anything
the script says about its own identity. A scope you declared but that wasn't granted fails at the
call site with a real error, not at load.

Because a script's `scopes` aren't known until after its first run, that first execution can have
its calls rejected: open the popup, press **Grant**, and subsequent runs work.

Grants are also tied to the exact source you approved. Change the file and the grant no longer
applies — you'll be asked again, the same as Tampermonkey does on script update.

### Storage is private to your script

`storage.rw` gives you a key/value store namespaced to your script. You cannot read another
script's data, and you cannot reach the extension's own records — every key you pass is placed
inside your namespace, so `storage.get('synapse:grants')` reads *your* `'synapse:grants'` key
(almost certainly `undefined`) and never the extension's.

### Cross-origin requests under the extension's identity

`page.fetch` (disclosed) is just `fetch`/`XMLHttpRequest` from the page — subject to the page's own
CORS policy, same as any other script running there. `net.request` is different: it runs in the
background, under the *extension's* identity, so it reaches any origin regardless of what that
origin's CORS headers say. This is the delta a page script cannot close on its own, and it's why
`net.request` is **enforced**, not disclosed — and always requires `match`:

```javascript
__synapseModule = {
  id: 'weather-widget',
  scopes: [{ scope: 'net.request', match: ['https://api.weather.example/*'] }],
  async run(input, ctx) {
    const res = await ctx.api.net.request({ url: 'https://api.weather.example/today' });
    if (res.status !== 200) throw new Error(`weather API returned ${res.status}`);
    console.log(JSON.parse(res.body));
  },
};
```

- **`match` is required, not optional.** A grant is (action × origin) — `{ scope, match: [...] }`,
  the same shape Tampermonkey's `@connect` uses. `options.url` must fall under one of the granted
  patterns or the call rejects, even if `net.request` itself was granted.
- **A non-2xx status resolves normally**, it doesn't throw — check `res.status` yourself, the same
  way `fetch()` itself only rejects on a network failure.
- **Binary responses**: pass `responseType: 'arraybuffer'` and decode `res.body` from base64
  (`bodyEncoding` on the response tells you which encoding you got, so don't assume).
- **Binary request bodies**: base64-encode them yourself and pass `bodyEncoding: 'base64'` alongside
  `body` — `body` must be a string, since it crosses the same structured-clone boundary as every
  other argument here.

### Saving a file to disk

`files.save` writes to your Downloads folder — the `GM_download` delta, since there's no page API
that reaches the filesystem:

```javascript
__synapseModule = {
  id: 'export-notes',
  scopes: ['files.save'],
  async run(input, ctx) {
    const notes = { exportedAt: new Date().toISOString(), text: document.body.innerText };
    await ctx.api.files.save({
      filename: 'notes/export.json',
      content: JSON.stringify(notes, null, 2),
    });
  },
};
```

- **No `match` needed** — unlike `net.request`, a file you write can't itself exfiltrate anything,
  so there's no origin to scope the grant to.
- **`filename` is relative to the Downloads folder**, and may include subfolders. It can never be
  absolute, use a drive letter, or contain a `..` segment — those are rejected before anything is
  written, not sanitized silently.
- **Binary content**: base64-encode it yourself and pass `contentEncoding: 'base64'` alongside
  `content` — same convention `net.request` uses for binary bodies/responses.
- **Size cap**: 10MB. Above that, generate the file server-side or split it — this call encodes
  synchronously, so a much larger file would block the extension's background for the whole call.

### Faking network responses

`net.mock` answers matching requests with a canned response instead of letting them reach the
network — for testing error handling, or working against an API that doesn't exist yet:

```javascript
__synapseModule = {
  id: 'offline-demo',
  scopes: [{ scope: 'net.mock', match: ['https://api.example.com/*'] }],
  async run(input, ctx) {
    const { id } = await ctx.api.net.mock.add({
      endpointPattern: 'https://api.example.com/users/*',
      fakeStatus: 200,
      fakeResponse: { users: [] },
    });
    await ctx.api.net.mock.remove(id); // stop faking it
  },
};
```

- **`endpointPattern` needs a literal scheme and host** — `https://api.example.com/*` is fine,
  `*://*.example.com/*` is not. Only the path may use `*`, and it must fall under one of the
  `match` patterns this call was granted, the same (action × origin) check `net.request` does.
- **Only fakes responses, for now.** There's no way to block a request or rewrite it before it goes
  out from this API — those, and a rule visible in DevTools' Network tab, are still Management
  View-only (the "HTTP Mock & Rewrite" panel), configured by hand.
- **`.list()`/`.remove()` only ever see your own script's rules** — never another script's, and
  never one a person set up by hand in the Management View.
- **It only ever intercepts the PAGE's own `fetch`/`XMLHttpRequest` — never yours.** The rule works
  by patching `window.fetch`/XHR in the page's MAIN world. Your script runs in a *separate* world
  (USER_SCRIPT) that shares the page's DOM but not its JS globals, so **your own script calling
  `fetch(...)` is calling the real, unpatched one** — it just reaches the real network (and can hit
  a real CORS error for a cross-origin URL, the same as any ordinary page script would). This isn't
  a bug to work around — if you want to see the fake response yourself, either read it off the page
  after the page's own code fetches it, or check it manually from the page's own DevTools console
  (not your script's). `ctx.api.net.request` is unrelated to all of this too — a separate call under
  the extension's own identity, never intercepted by a `net.mock` rule either way.

### Detecting, inspecting and downloading media

`media` lists what the network sniffer has already detected (video/audio files, HLS manifests),
inspects an HLS manifest fresh, and starts/polls/controls a download — the same engine the Side
Panel's Download button drives, fronted as a plain `jobId` string so nothing live (an
`AbortController`, an in-progress file) ever has to cross the RPC boundary:

```javascript
__synapseModule = {
  id: 'auto-downloader',
  scopes: ['media'],
  async run(input, ctx) {
    const found = await ctx.api.media.list();
    const stream = found.find((m) => m.kind === 'stream');
    if (!stream) return;

    const jobId = await ctx.api.media.download({ url: stream.url });
    // poll — see below for the onProgress push alternative
    let status;
    do {
      await new Promise((r) => setTimeout(r, 1000));
      status = await ctx.api.media.job(jobId);
    } while (status && status.phase !== 'done' && status.phase !== 'error');
  },
};
```

- **One scope covers everything** — `list`/`inspect`/`download`/`job`/`control` all gate on
  `media`, and it never takes `match`: a grant is all-or-nothing, same as the Side Panel's own view
  of whatever the sniffer has found.
- **`download()` returns immediately** with a `jobId` — it does not wait for the file to finish.
  `ctx.api.media.job(jobId)` polling (above) always works and returns `undefined` until there's a
  snapshot to report, and again after a background service-worker restart, since progress isn't
  persisted to disk any more than the Side Panel's own view of it is.
- **`ctx.api.media.onProgress(jobId, handler)` is a push alternative to polling**, confirmed working
  on real Chrome (docs/api-inventory.md §6 item 8). Synchronous, takes a closure, returns an
  unsubscribe function — it never crosses the RPC boundary the way every other `media.*` method does
  (a function-valued parameter cannot survive structured clone), so it costs nothing extra to also
  keep a `job()` poll running as a belt-and-suspenders fallback (a background service-worker restart
  between the push and your handler still loses it, same as any other in-memory-only state here):
  ```javascript
  const unsubscribe = ctx.api.media.onProgress(jobId, (status) => console.log(status));
  // ... later, once you no longer care ...
  unsubscribe();
  ```
- **`url` has to look like media** — an `.m3u8`/`.mpd` runs the HLS engine, a recognized direct-file
  extension (`.mp4`, `.mp3`, …) runs the multi-connection downloader. Anything else is refused before
  a job is even created; pass a URL from `list()` or one of a master entry's `variants`.
- **`inspect(url)` is a fresh fetch+parse**, not a cached read — useful for a `variants` entry
  `list()` hasn't gotten around to auto-inspecting yet. Resolves to `{}` for a URL that isn't
  parseable HLS, the same "no crafted fallback" posture as `lib.readable`.
- **`control(jobId, action)`** takes `'pause' | 'resume' | 'cancel' | 'stop-live'` — `'stop-live'`
  only means something for a live (no-`#EXT-X-ENDLIST`) capture, and is a no-op otherwise.

### Running code in the page's own JS context

`page.eval` runs code directly in the page's MAIN-world JS context — the same place a
hand-authored `<script>` tag on that page would run, and Tampermonkey's `unsafeWindow` in spirit.
Your script normally runs in the USER_SCRIPT world, which shares the page's DOM but *not* its JS
globals (see "Faking network responses" above for why that separation matters) — `page.eval` is
the one deliberate way through it:

```javascript
__synapseModule = {
  id: 'read-page-global',
  scopes: [{ scope: 'page.eval', match: ['https://example.com/*'] }],
  async run(input, ctx) {
    const title = await ctx.api.page.eval('return document.title;');
    const sum = await ctx.api.page.eval('return args[0] + args[1];', [2, 3]);
  },
};
```

- **The highest-privilege scope there is, and the only one with no partial version.** Once
  granted, `code` runs with the full authority of the page's own JS context — every global, every
  cookie-backed request, every DOM mutation a real `<script>` tag could do. There is no
  sandboxing inside `code` itself; only grant it to sites you trust running your own script on.
- **`match` is checked against the tab you're actually running on — not a URL you pass in.**
  There is no `url` argument to this call, unlike `net.request`/`net.mock`: the resource *is*
  whichever page your script is injected into, and the platform reads that itself rather than
  trusting anything the call could claim.
- **`code` is a function body, not an expression** — write `return x;`, not just `x`. `await`
  works inside it (it runs as the body of an async function), and `args` (the second, optional
  parameter to `page.eval`) shows up inside `code` as its own `args` array.
- **Same structured-clone rules as everything else that crosses the RPC boundary**: whatever
  `code` returns must survive it — a DOM node, a live object, or a function cannot come back as the
  resolved value, only plain data.
- **Best-effort, not a bypass.** A page whose Content-Security-Policy excludes `unsafe-eval` in
  its `script-src` blocks the mechanism `page.eval` relies on internally — the call rejects with
  that page's own CSP error instead of running. There's no workaround for that today.

### `lib` — pure helpers, no scope, no `await`

`ctx.api.lib` is different from everything above it: it costs nothing to grant because it grants
nothing. It's computation on data you already have in hand — nothing privileged, nothing that
leaves your script — so there's no scope to declare and no message crosses to the background:

```javascript
__synapseModule = {
  id: 'hls-inspector',
  // No `scopes` entry needed for lib.hls.parse itself.
  async run(input, ctx) {
    const res = await fetch('https://example.com/stream.m3u8'); // page.fetch, disclosed
    const manifest = ctx.api.lib.hls.parse(await res.text(), res.url);
    console.log(manifest.kind); // 'master' | 'media' | 'unknown'
  },
};
```

Like `ui`, `lib` methods are synchronous — no `await`, no dropped-function surprises, because
nothing ever crosses the RPC boundary.

- **`lib.hls.parse(text, baseUrl)`** — parses an `.m3u8` playlist you've already fetched, the same
  parser the `network-sniffer` builtin uses.
- **`lib.readable(doc?)`** — runs Mozilla's Readability (the engine behind Firefox's Reader View,
  and what the `reader-mode-converter` builtin uses) and returns `{ title, root, text }`, or
  `undefined` if the page isn't an article. **Mutates `doc`**; omit it and Synapse clones the
  current page's `document` for you so your own page is left untouched.
- **`lib.toMarkdown(root, { baseUrl, resolveImageUrl? })`** — converts a DOM subtree to Markdown.
  `resolveImageUrl` lets you point `<img>` links at local copies you've already downloaded via
  `net.request` instead of the original remote URL.
- **`lib.zip(entries)`** — builds an uncompressed `.zip` from `{ name, data: Uint8Array }[]`. Hand
  the result to `files.save` with `contentEncoding: 'base64'`.
- **`lib.matchPattern`** — the exact matcher `net.request`/`net.mock` enforce `match` grants
  against, exposed rather than re-implemented (Chrome's match-pattern syntax has real edge cases —
  `*.example.com` only matches subdomains, `*` as a scheme means http/https only — that a naive
  regex gets subtly wrong). `isValid(pattern)` checks the pattern itself is well-formed;
  `test(url, pattern)`/`testAny(url, patterns)` check a URL against one or several. Handy for
  pre-filtering a batch of candidate URLs against your own `match` list before firing `net.request`
  for each one, instead of discovering the rejection one call at a time:

  ```javascript
  const links = Array.from(document.querySelectorAll('a')).map((a) => a.href);
  const myPatterns = ['https://api.example.com/*'];
  const inScope = links.filter((url) => ctx.api.lib.matchPattern.testAny(url, myPatterns));
  ```

Put together, these plus `net.request` (image fetch) and `files.save` (writing the result) are
enough to recreate the shape of the `reader-mode-converter` builtin entirely from user-script level
— see [`docs/examples/test-lib-reader-mode.js`](examples/test-lib-reader-mode.js).

### On-page UI is yours alone

`ui.render` gives you toasts, up to two icons in the shared top-right column, and badges pinned to
page elements:

```js
ctx.api.ui.icon({ id: 'go', label: '⚡', title: 'Run it', onClick: () => doSomething() });
ctx.api.ui.toast({ id: 'done', message: 'Finished', actionLabel: 'Undo', onAction: () => undo() });
```

Three things behave differently here from every other namespace, all for the same reason — **`ui`
runs inside your own world and sends no message**:

- **The methods are synchronous.** No `await`. They return `true`, or `false` when the call was
  refused (over quota, or toasting too fast). A `false` is never a silent no-op — check it if it
  matters. Note that the user hiding your UI from the popup is *not* a refusal: the surface is
  still created and returns `true`, it simply is not displayed until they unhide it, at which point
  everything you drew in the meantime appears.
- **Callbacks work.** `onClick` is a real closure, unlike anywhere else in `synapseApi`, where a
  function argument would be dropped crossing to the background.
- **Ids are local to your script.** Two scripts can both use `id: 'main'` without colliding, and
  passing another script's id to `dismiss()` does nothing at all — the platform namespaces every id
  by the script that supplied it, so a surface belonging to someone else is not addressable.

`ui.render` is *disclosed*, not enforced: a script that shares the page can already append whatever
it likes to the DOM, so denying it would protect nobody. What the platform actually adds is
placement, quota, teardown, and styling that survives a strict `style-src` CSP.

## Identity

`chrome.userScripts.register()` needs a script id *before* your code has ever run, so the extension
assigns its own (a UUID) at upload time. That is the canonical id used for activation, grants, RPC
routing, and your storage namespace. Your `__synapseModule.id` is read back after the first
execution and shown as a friendly label — it never affects routing or storage, and claiming another
module's id in it gets you nothing.

## Several scripts at once

All uploaded scripts share one `USER_SCRIPT` world per page. Synapse wraps each one in its own
function scope, so your top-level `const`/`let`/`function` declarations don't collide with another
script's — and neither do the extension's own. Anything you deliberately put on `globalThis` *is*
shared, so prefix it if you want it to stay yours. This is also the reason the API is handed to you
per-call as `ctx.api` instead of being published under a shared global name.

## Failure handling

There's no type-checking for uploaded code, so failures are reported rather than crashing anything:

- A syntax error is caught at registration time (the upload fails with a reason).
- A missing/malformed `__synapseModule` (no `id`, no `run`, an unknown scope name) shows as
  **invalid** in the popup with the reason.
- A `run()` that throws is caught and reported — it never crashes the extension.

An unknown scope name is a hard error rather than something quietly ignored. A permission that
silently resolves to nothing is worse than one that fails loudly, which is the lesson the retired
`needs: ['net' | 'dom']` model taught.

## Migrating from `needs`

Older scripts declared `needs: ['ai' | 'cache' | 'bus' | 'net' | 'dom']` and called
`synapse.cache.*` / `synapse.bus.*` / `synapse.ai.*`. That model is gone:

| Old | Now |
|---|---|
| `synapse.cache.get/set` | `ctx.api.storage.get/set/remove/keys` under `storage.rw` — namespaced per script |
| `synapse.bus.emit/on` | *(removed)* — `bus` reached every built-in module's listener, a permission no prompt could describe honestly. `.on()` never worked anyway: a handler function can't cross the clone boundary |
| `synapse.ai.ask` | *(removed for now)* — it had no implementation behind it and always threw. It comes back as a thin, explicitly-scoped helper |
| `needs: ['net'\|'dom']` | *(removed)* — these resolved to nothing at all |

A leftover `needs` field is ignored rather than rejected, but it grants nothing: add `scopes` and
re-grant from the popup.
