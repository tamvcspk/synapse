# Synapse User Script API — AI Context Bundle

Synapse v0.1.0, bundle generated 2026-08-06. This file is self-contained context for an AI
assistant writing a Synapse user script — no other file or link is needed. If the extension version
you're actually working against differs from the one above, treat this bundle as possibly stale: a
scope or method it doesn't mention may have been added or changed since.

---

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

### Storage has three lifetimes, not just one

`storage.get/set/remove/keys` (above) is **permanent** — it survives forever, until you `remove()`
it yourself. Two more namespaces sit beside it, same scope (`storage.rw`, no extra permission),
same four operations, different eviction:

- **`storage.tab.*`** — dies when the tab your script is running in *closes*. Survives navigation
  and reload within that tab.
- **`storage.session.*`** — dies on the tab's *next navigation*, including a reload of the exact
  same URL. Use this for "state for the page I'm currently looking at" that shouldn't silently pile
  up across reloads — you never have to clean it up yourself.

```javascript
__synapseModule = {
  id: 'view-counter',
  scopes: ['storage.rw'],
  async run(input, ctx) {
    // Survives a reload of this exact page — resets only when you actually navigate away.
    const viewsThisLoad = ((await ctx.api.storage.session.get('views')) ?? 0) + 1;
    await ctx.api.storage.session.set('views', viewsThisLoad);

    // Survives navigating around the same tab — resets only when the tab itself closes.
    const tabsSeen = ((await ctx.api.storage.tab.get('visited')) ?? 0) + 1;
    await ctx.api.storage.tab.set('visited', tabsSeen);
  },
};
```

Both are only usable from code attached to a real tab (a dom Module or an uploaded script) — a
background Module has no tab of its own, and calling either throws a clear error explaining why,
rather than silently doing nothing.

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

### Using a secret without ever seeing it

Some APIs need a key (`Authorization: Bearer sk-...`) that you don't want sitting in your script's
source — anyone you share the script with would get the key too. `secretRef` solves this: you
reference a secret **by name**, and the platform substitutes the real value into the header at the
network boundary. Your script never receives it, in any form.

```javascript
__synapseModule = {
  id: 'ask-openai',
  scopes: [
    { scope: 'net.request', match: ['https://api.openai.com/*'] },
    'secrets.use',
  ],
  async run(input, ctx) {
    const res = await ctx.api.net.request({
      url: 'https://api.openai.com/v1/models',
      headers: { Authorization: { secretRef: 'my-openai-key', format: 'Bearer {}' } },
    });
    console.log(res.status);
  },
};
```

- **Create the secret first, in the Dashboard's Secrets panel** (popup → gear icon on "Secrets" →
  Dashboard) — never from a script. Give it the name you'll reference (`my-openai-key`), the value,
  and the one host it's allowed to reach (a match pattern, e.g. `https://api.openai.com/*`).
- **`secrets.use` is required in addition to `net.request` itself** — declaring only one of the two
  scopes gets you a clear rejection, not a partial success.
- **Three checks, all independent, all have to pass**: your `net.request` grant's own `match` must
  cover `url` (same as any other `net.request` call); your script must have `secrets.use` granted at
  all; and the secret's own `allowedHost` (set once, in the Dashboard, never by a script) must also
  cover `url`. A secret bound to `api.openai.com` cannot be pointed at a different host by widening
  your `net.request` grant — the two checks are unrelated.
- **`format` defaults to `'{}'`** (the bare value) — use it to wrap the secret, e.g.
  `'Bearer {}'`. It must contain `{}` somewhere, or the call is rejected rather than silently
  sending a header with no secret in it.
- **There is no `secrets.read` scope, and no way to list secrets.** A script can only reference a
  name it already knows — reading one back, or discovering what secrets exist, is not something any
  scope can grant. If you need the value for something other than a `net.request` header, this API
  isn't the tool for it.
- **Sharing your script is safe by construction**: the script only ever contains the *name*
  `my-openai-key`, never the value. Whoever runs it creates their own secret under that name.

### Calling an AI provider

`ai.ask` is a thin `{provider, model, messages} → text` helper for OpenAI and Ollama chat
completions — not a unified LLM abstraction, and not an agent. It shapes the request and extracts
the reply text for you; anything beyond that (streaming, other providers, vision, tool calling) is
`net.request` + `secretRef`, which you already have full access to.

```javascript
__synapseModule = {
  id: 'summarize-with-ollama',
  scopes: [{ scope: 'net.request', match: ['http://localhost:11434/*'] }],
  async run(input, ctx) {
    const result = await ctx.api.ai.ask({
      provider: 'ollama',
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'Summarize this in one sentence: ' + input }],
    });
    console.log(result.text);
  },
};
```

- **No scope of its own — gated on `net.request`.** `ai.ask` doesn't open any door `net.request` +
  `secretRef` didn't already open, so it reuses that scope's `match` check instead of adding a
  separate one: your grant's `match` must cover the provider's endpoint (the default, or your own
  `baseUrl`), exactly as if you'd called that endpoint via `net.request` directly.
- **Provider defaults**: `'openai'` → `https://api.openai.com/v1/chat/completions`; `'ollama'` →
  `http://localhost:11434/api/chat`. Override with `baseUrl` for a self-hosted Ollama or an
  OpenAI-compatible proxy — it still has to fall under your granted `match`.
- **`secretRef` works the same way it does for `net.request`** (see the section above) — required
  for `'openai'` (no key, no request), meaningless for `'ollama'` (local, no auth) even if given.
  Needs `secrets.use` in addition to `net.request`, same two-scope shape.
- **v1 does not stream.** A reply arrives as one value, not incrementally — `chrome.runtime.sendMessage`
  carries a single response, and streaming would need a different transport (`chrome.runtime.connect`)
  this version doesn't use.
- **Ollama and CORS**: `ai.ask` runs in the background, so the request to your local Ollama carries
  the extension's own origin (`chrome-extension://…`), which Ollama's default origin allowlist
  rejects. Start it with `OLLAMA_ORIGINS=*` (or your extension's specific origin) for this to work.

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

### Faking, blocking, or rewriting network requests

`net.mock` answers matching requests with a canned response, fails them outright, or rewrites them
before they go out — for testing error handling, or working against an API that doesn't exist yet:

```javascript
__synapseModule = {
  id: 'offline-demo',
  scopes: [{ scope: 'net.mock', match: ['https://api.example.com/*'] }],
  async run(input, ctx) {
    const { id } = await ctx.api.net.mock.add({
      endpointPattern: 'https://api.example.com/users/*',
      fakeStatus: 200,
      fakeResponse: { users: [] },
      // action defaults to 'fake-response' when omitted, same as before this field existed.
    });
    await ctx.api.net.mock.remove(id); // stop faking it
  },
};
```

- **`endpointPattern` needs a literal scheme and host** — `https://api.example.com/*` is fine,
  `*://*.example.com/*` is not. Only the path may use `*`, and it must fall under one of the
  `match` patterns this call was granted, the same (action × origin) check `net.request` does.
- **`action` picks WHAT the rule does — `'fake-response'` (default), `'rewrite-request'`, or
  `'block'`.** You never pick HOW it's intercepted; the platform always resolves the cheapest
  mechanism that can do it. `'block'` fails the request at the real network layer (not just a
  rejected Promise). `'rewrite-request'` accepts `rewriteUrl`/`rewriteMethod`/`rewriteHeaders`/
  `rewriteBody`, any subset — an omitted one keeps the original request's value.
- **One combination needs an extra grant: `net.mock.debugger`.** Add `matchAnyResourceType: true`
  alongside a `rewriteBody` when you need to rewrite a request NOT made via `fetch`/XHR — a bundled
  `<script src>` or a large `<img>` served straight from an HTML tag, for example. That's the one
  case `main-world`'s fetch/XHR patch can never see and `declarativeNetRequest` can never touch a
  body for, so it's the only combination that reaches `chrome.debugger` — which means Chrome shows a
  permanent "being debugged" banner on the tab for as long as the rule is active. Every other `action`
  (including `block`) only ever needs `net.mock` itself.
- **`.list()`/`.remove()` only ever see your own script's rules** — never another script's, and
  never one a person set up by hand in the Management View.
- **`fake-response` and most `rewrite-request` calls only ever intercept the PAGE's own
  `fetch`/`XMLHttpRequest` — never yours.** They work by patching `window.fetch`/XHR in the page's
  MAIN world. Your script runs in a *separate* world (USER_SCRIPT) that shares the page's DOM but not
  its JS globals, so **your own script calling `fetch(...)` is calling the real, unpatched one** — it
  just reaches the real network (and can hit a real CORS error for a cross-origin URL, the same as
  any ordinary page script would). This isn't a bug to work around — if you want to see a
  `fake-response` yourself, either read it off the page after the page's own code fetches it, or
  check it manually from the page's own DevTools console (not your script's). `ctx.api.net.request`
  is unrelated to all of this too — a separate call under the extension's own identity, never
  intercepted by a `net.mock` rule either way. `block` and any `rewrite-request` that needs
  `net.mock.debugger` DO reach every resource type, page script included — see above.
- **File uploads, `hitCountLimit`, and body-content matching are Management View-only.** Those need
  a file picker or a typed match string that has no equivalent shape for a script call — configure
  them by hand in the "HTTP Mock & Rewrite" panel instead.

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

### Overriding one step of a platform pipeline

`pipeline.hook` lets your script fix a *specific* built-in behavior for a *specific* site, instead
of reimplementing the whole feature yourself. The platform declares a named *slot* inside one of
its own pipelines; your script registers a handler for it, scoped by `match` the same way
`net.request`/`net.mock` are. v1 has exactly one slot: `media.correlate-url`, for a site whose
video player streams through a `blob:` URL none of the built-in detection heuristics can resolve
to a real, downloadable URL on their own.

```javascript
__synapseModule = {
  id: 'fix-example-com-player',
  scopes: ['media'],
  async run(input, ctx) {
    await ctx.api.pipeline.hook('media.correlate-url', {
      match: ['*://videos.example.com/watch/*'],
      handler: (fireCtx) => {
        // Runs only on pages under `match`, and only when none of the platform's own 3 correlation
        // signals already placed the video — your own site-specific knowledge fills the gap.
        const el = document.querySelector('video.player[data-manifest]');
        if (!el) return [];
        return [{ cssSelector: 'video.player[data-manifest]', url: el.dataset.manifest }];
      },
    });
  },
};
```

- **Gated on `media`** — the same scope `list`/`inspect`/`download`/`job` already use, not a
  separate one: hooking a `media.*` slot needs the same permission calling `media.*` directly would.
- **`handler` runs in your own world, like `ui.*`/`media.onProgress`** — a function-valued argument
  cannot cross the RPC boundary, so it never leaves the page. Only its return value (plain data) is
  reported back.
- **Return CSS selectors, not elements.** `document.querySelector` inside `handler` runs against the
  same live page DOM your script already has (`page.dom`, Disclosed) — the platform re-resolves your
  selector against that DOM after `handler` returns, rather than trying to pass the element itself
  across a world boundary. An entry whose selector no longer matches anything is skipped, not an
  error.
- **Two scripts hooking the same slot for overlapping pages**: the more specific `match` pattern
  wins. A tie breaks by script order — there is no reorder UI for this yet, so today that's a
  placeholder (alphabetical by script name), not a setting you can configure.
- **`hook()` resolves to an unsubscribe function**, same shape as `media.onProgress`. You don't need
  to call it under normal circumstances — a fresh page load re-registers anyway, since your script's
  top-level code runs again on every navigation.

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
| `synapse.ai.ask` | `ctx.api.ai.ask({provider, model, messages})` under `net.request`'s own scope+match — see "Calling an AI provider" above. The old `synapse.ai.ask` had no implementation behind it and always threw; this is a different, thin helper, not a revival of the old `AiService` Port |
| `needs: ['net'\|'dom']` | *(removed)* — these resolved to nothing at all |

A leftover `needs` field is ignored rather than rejected, but it grants nothing: add `scopes` and
re-grant from the popup.

---

## Full type reference

Generated straight from the extension's own source (`kernel/synapse-api.ts` + `kernel/scopes.ts`),
authoritative over anything above if the two ever disagree. Every scope and every `synapseApi.*`
method, with the same descriptions the in-extension consent screen shows.

```typescript
/**
 * Types for writing a Synapse user script — GENERATED from src/kernel/synapse-api.ts and
 * src/kernel/scopes.ts. Do not edit by hand: regenerate with `npm test -- -u`.
 *
 * Reference this file in your own editor for autocomplete. It has no effect on the extension build
 * (it lives outside src/, which is all tsconfig.json includes) and is never imported at runtime:
 * `synapseApi` and `__synapseModule` are plain globals the extension injects around your code.
 * See docs/user-scripts.md for the authoring convention.
 */

/**
 * ## Scopes
 *
 * ### Enforced — the call fails if the user denies it
 *
 * - `storage.rw` — Store this script's own data.
 *   Read and write a key/value store private to this script. Keys are namespaced by the
 *   platform: this script cannot see another script's data, nor the extension's own settings.
 * - `net.request` — Make network requests, under this extension's identity, to {domains}.
 *   Fetch cross-origin under the extension's own identity rather than the page's — not subject
 *   to the page's CORS policy, the delta a page script cannot close on its own
 *   (docs/api-inventory.md §2, "priority #1"). Always carries `match`: a grant is (action ×
 *   origin), the same shape as Tampermonkey's `@connect`, so a script can only reach the origins
 *   it declared.
 *   Requires a `match` list: `{ scope, match: [...] }`.
 * - `files.save` — Save files to disk.
 *   Write a file into the Downloads folder — the `GM_download` delta a page script has no way to
 *   close on its own. No resource dimension: unlike `net.request`, a written file cannot itself
 *   exfiltrate anything, so there is no origin to scope it to.
 * - `net.mock` — Fake network responses on {domains}.
 *   Answer matching requests to {domains} with a canned response instead of letting them reach
 *   the network — for testing error handling or working against an API that is not up yet
 *   (docs/api-inventory.md §3.2). v1 only ever fakes a response (no block/rewrite) and always
 *   runs under the cheapest mechanism (a MAIN-world fetch/XHR patch, no DevTools "being
 *   debugged" banner) — a script cannot request `debugger` or `dnr` directly.
 *   Requires a `match` list: `{ scope, match: [...] }`.
 * - `net.mock.debugger` — Intercept requests to {domains} at the real network layer — Chrome will show a permanent "being debugged" banner on affected tabs.
 *   Required in ADDITION to `net.mock` for the one combination `main-world`/`dnr` cannot cover:
 *   rewriting the BODY of a request not initiated by `fetch`/XHR — a real, common case, not a
 *   theoretical one: mocking a bundled `<script src>` (e.g. swapping in a patched build) or a
 *   large `<img>` served straight from an HTML tag both need this, since neither is a
 *   `fetch`/XHR call `main-world`'s patch would ever see, and `dnr` cannot touch a request body
 *   at all (docs/ROADMAP.md Track B2b). `net.mock.add` never asks for this directly — the
 *   platform reaches for the `debugger` mechanism only when the declared `action`/hints leave no
 *   cheaper mechanism able to do the job (`chooseMechanismForScriptRule`, shared/http-mock.ts),
 *   and `rpc-handler.ts` runs that exact same decision before dispatch to require this grant.
 *   Chrome shows an unmissable "being debugged" banner for as long as any rule using it is
 *   active — the consent line must say so, never just "network access". Reuses `net.mock`'s own
 *   match dimension: a script that already declared `net.mock` for an origin only needs this AS
 *   WELL to unlock the debugger-only combination there, not a second, independent origin list.
 *   Requires a `match` list: `{ scope, match: [...] }`.
 * - `media` — Detect, inspect and download media (video/audio/HLS) found on any page.
 *   List media the network sniffer has detected, inspect an HLS manifest, and start/poll/control
 *   a download - the GM_video-shaped hole Tampermonkey has no equivalent for at all
 *   (docs/api-inventory.md section 3.1). One scope for list/inspect/download/job/control:
 *   splitting detection from download would be an empty two-prompt ritual (anyone who allows
 *   detection also wants to download). No `match` dimension - unlike `net.request`/`net.mock`,
 *   this is all-or-nothing, the same posture the Side Panel already takes toward everything it
 *   detects.
 * - `page.eval` — Run arbitrary code in the page's own JavaScript context on {domains}.
 *   Execute code directly in the page's MAIN-world JS context — the `unsafeWindow` delta a
 *   USER_SCRIPT-world script has no way to close on its own (docs/api-inventory.md §2). The
 *   highest-privilege scope in the catalog: granted code runs with the full authority of the
 *   page's own JS context, not a sandboxed subset. Requires `match`, but the resource checked is
 *   not an argument the script provides — it is the calling tab's REAL url, read from the
 *   platform's own record of the call, so a script cannot widen its own reach by lying about
 *   which page it is calling from.
 *   Requires a `match` list: `{ scope, match: [...] }`.
 * - `secrets.use` — Use named secrets it declares, inside network requests it makes.
 *   Lets `net.request` substitute a header value from a secret this script references by name
 *   (`secretRef`) — the script never receives the secret itself, only the ability to have the
 *   platform inject it at the network boundary (docs/ROADMAP.md §11.6). No scope named
 *   `secrets.read` exists, and none ever will: reading a secret back out is not a capability any
 *   script can be granted, and there is no way to list secrets either — a script must already
 *   know the exact name it wants. Each secret is independently bound to one host at creation
 *   time (Dashboard-only, never scriptable) — this scope only gates whether the script may
 *   reference a secret AT ALL; which host it may reach with it is that secret's own binding,
 *   checked regardless of this grant. No `match` here: the resource dimension already belongs to
 *   `net.request`'s own grant and to the secret's binding — a third, independent match list on
 *   this scope would just be a second place for the same fact to drift out of sync.
 *
 * ### Disclosed — the script can do this anyway; declaring it is transparency, not a gate
 *
 * - `page.dom` — Read and modify the content of pages it runs on.
 *   The script reads or changes the page it is injected into. Disclosed, not enforced: a script
 *   running on the page already shares its DOM, so `document.querySelector` works whether or not
 *   this is granted. It becomes genuinely enforced only for scripts hosted in a sandboxed frame
 *   (docs/ROADMAP.md §11.8), which have no page DOM at all.
 * - `ui.render` — Show toasts, icons and badges on pages it runs on.
 *   Draw into Synapse's on-page UI space: toasts, a top-right icon, badges pinned to page
 *   elements. Disclosed, not enforced, for exactly the reason `page.dom` is: a script that
 *   shares the page can already append anything it likes to the document, so refusing this
 *   protects nobody — what the platform adds is placement, quota and teardown, not permission.
 *   It becomes a real gate for scripts hosted in a sandboxed frame (docs/ROADMAP.md §11.8),
 *   which have no page DOM to draw on at all.
 * - `page.fetch` — Make its own network requests from the page.
 *   The script calls `fetch`/`XMLHttpRequest` itself, subject to the page's CORS rules.
 *   Disclosed for the same reason as `page.dom` — the script already has these globals. It is
 *   NOT the same as making requests under the extension's identity, which `net.request` grants.
 *
 * ## Methods
 *
 * - `synapseApi.storage.get(key: string): Promise<unknown>` — requires `storage.rw`.
 *   Read one of this script's own keys. Resolves to `undefined` when unset.
 * - `synapseApi.storage.set(key: string, value: unknown): Promise<void>` — requires `storage.rw`.
 *   Write one key. The value must survive structured clone (no functions, no DOM nodes).
 * - `synapseApi.storage.remove(key: string): Promise<void>` — requires `storage.rw`.
 *   Delete one key.
 * - `synapseApi.storage.keys(): Promise<string[]>` — requires `storage.rw`.
 *   List every key this script has written, without the internal namespace prefix.
 * - `synapseApi.storage.get(key: string): Promise<unknown>` — requires `storage.rw`.
 *   Read one of this script's own tab-scoped keys. Resolves to `undefined` when unset.
 * - `synapseApi.storage.set(key: string, value: unknown): Promise<void>` — requires `storage.rw`.
 *   Write one tab-scoped key — evicted when the calling tab closes, survives navigation within
 *   it.
 * - `synapseApi.storage.remove(key: string): Promise<void>` — requires `storage.rw`.
 *   Delete one tab-scoped key.
 * - `synapseApi.storage.keys(): Promise<string[]>` — requires `storage.rw`.
 *   List this script's own tab-scoped keys for the calling tab.
 * - `synapseApi.storage.get(key: string): Promise<unknown>` — requires `storage.rw`.
 *   Read one of this script's own session-scoped keys. Resolves to `undefined` when unset.
 * - `synapseApi.storage.set(key: string, value: unknown): Promise<void>` — requires `storage.rw`.
 *   Write one session-scoped key — evicted on the calling tab's next navigation commit,
 *   including a same-URL reload.
 * - `synapseApi.storage.remove(key: string): Promise<void>` — requires `storage.rw`.
 *   Delete one session-scoped key.
 * - `synapseApi.storage.keys(): Promise<string[]>` — requires `storage.rw`.
 *   List this script's own session-scoped keys for the calling tab.
 * - `synapseApi.ui.toast(options: { id, message, actionLabel?, onAction? }): boolean` — requires `ui.render` (runs in your own world — synchronous).
 *   Show a card bottom-right; reusing an id updates it in place. Returns false if refused (rate
 *   limit, quota, or the user muted this script's UI).
 * - `synapseApi.ui.icon(options: { id, label, title?, onClick }): boolean` — requires `ui.render` (runs in your own world — synchronous).
 *   Show a persistent round button top-right. Two per script at most.
 * - `synapseApi.ui.badge(options: { id, target, label, title?, onClick }): boolean` — requires `ui.render` (runs in your own world — synchronous).
 *   Pin a small button to a page element, following it as the page scrolls and removing it once
 *   the element leaves the document.
 * - `synapseApi.ui.dismiss(kind: 'toast' | 'icon' | 'badge', id: string): void` — requires `ui.render` (runs in your own world — synchronous).
 *   Remove one of your own surfaces. Ids are local to your script.
 * - `synapseApi.ui.clear(): void` — requires `ui.render` (runs in your own world — synchronous).
 *   Remove everything this script has drawn.
 * - `synapseApi.net.request(options: SynapseNetRequestOptions): Promise<SynapseNetResponse>` — requires `net.request`.
 *   Fetch a URL under the extension's identity, not the page's — bypasses the page's CORS
 *   policy. `options.url` must fall under one of this call's granted `match` patterns. A header
 *   value may reference a named secret instead of a plain string — see `secrets.use`.
 * - `synapseApi.files.save(options: SynapseFilesSaveOptions): Promise<SynapseFilesSaveResult>` — requires `files.save`.
 *   Write `options.content` to `options.filename` inside the Downloads folder.
 * - `synapseApi.net.mock.add(options: SynapseMockRuleOptions): Promise<{ id: string }>` — requires `net.mock`.
 *   Fake matching requests with a canned response. `options.endpointPattern` must have a literal
 *   (non-wildcard) scheme and host falling under one of this call's granted `match` patterns —
 *   only the path may use `*`; the mechanism (always the cheapest one) is chosen by the
 *   platform, not requested.
 * - `synapseApi.net.mock.remove(id: string): Promise<void>` — requires `net.mock`.
 *   Remove one of this script's own rules. Ids from another script or from the Management View
 *   are refused.
 * - `synapseApi.net.mock.list(): Promise<SynapseMockRule[]>` — requires `net.mock`.
 *   List this script's own rules — never another script's or the user's manually-created ones.
 * - `synapseApi.media.list(): Promise<SynapseMediaEntry[]>` — requires `media`.
 *   Every media file the network sniffer has detected so far — the same list the Side Panel
 *   shows.
 * - `synapseApi.media.inspect(url: string): Promise<SynapseMediaInspectResult>` — requires `media`.
 *   Fetch and parse an HLS manifest URL fresh (not a cached read).
 * - `synapseApi.media.download(options: SynapseMediaDownloadOptions): Promise<string>` — requires `media`.
 *   Start a download; returns the jobId immediately without waiting for completion.
 * - `synapseApi.media.job(jobId: string): Promise<SynapseMediaJobStatus | undefined>` — requires `media`.
 *   Poll a snapshot of a download started by media.download — no subscription exists
 *   (docs/api-inventory.md §4).
 * - `synapseApi.media.control(jobId: string, action: 'pause' | 'resume' | 'cancel' | 'stop-live'): Promise<void>` — requires `media`.
 *   Act on a job started by media.download.
 * - `synapseApi.media.onProgress(jobId: string, handler: (status: SynapseMediaJobStatus) => void): () => void` — requires `media` (runs in your own world — synchronous).
 *   Push updates for a job started by media.download, instead of polling job() — the first real
 *   use of the subscription mechanism docs/api-inventory.md §4 spiked (§6 item 8), confirmed on
 *   real Chrome. Runs in your own world, like ui.*, and never reaches this scope check the way
 *   job()/download() do (a function-valued handler cannot cross the RPC boundary at all).
 * - `synapseApi.pipeline.hook(slotName: 'media.correlate-url', options: SynapsePipelineHookOptions): Promise<() => void>` — requires `media` (runs in your own world — synchronous).
 *   Register a handler for a named platform-pipeline slot, scoped by match — a script overrides
 *   one step of a built-in pipeline instead of forking the whole feature (docs/ROADMAP.md §11.6
 *   Tier 2). Runs in your own world, like ui.*/media.onProgress, since a function-valued handler
 *   cannot cross the RPC boundary — internally calls the separate pipeline.register RPC method
 *   to persist {slotName, match}, which IS scope-checked; a denied registration never gets into
 *   the winner computation, so the locally-held handler here is simply never invoked.
 * - `synapseApi.page.eval(code: string, args?: unknown[]): Promise<unknown>` — requires `page.eval`.
 *   Run code in the page's own MAIN-world JS context (Tampermonkey's `unsafeWindow`, made an
 *   explicit call) — breaks the isolation the USER_SCRIPT world otherwise guarantees. `code`
 *   runs as an async function body; `args` become its own `args` parameter. Gated on the calling
 *   tab's REAL url falling under this call's granted `match` patterns — not a url the script
 *   provides.
 * - `synapseApi.ai.ask(options: SynapseAiAskOptions): Promise<SynapseAiAskResult>` — requires `net.request`.
 *   Thin {provider,model,messages} → text helper for OpenAI/Ollama chat completions — not a
 *   unified LLM abstraction, see the type doc comment. `options.baseUrl` (or the provider's
 *   default endpoint) must fall under one of this call's granted `net.request` `match` patterns,
 *   the same requirement calling that endpoint via `net.request` directly would carry. A
 *   `secretRef` additionally requires `secrets.use`, injected as `Authorization: Bearer
 *   <value>`.
 * - `synapseApi.lib.hls.parse(text: string, baseUrl: string): SynapseHlsManifest` — no scope required — pure computation (runs in your own world — synchronous).
 *   Parse an HLS (.m3u8) manifest already fetched by the script. No scope: pure computation on
 *   data the caller already has, granted no privilege (docs/api-inventory.md §3.0).
 * - `synapseApi.lib.readable(doc?: Document): { title, root, text } | undefined` — no scope required — pure computation (runs in your own world — synchronous).
 *   Extract the readable article from a Document via Mozilla Readability. Mutates `doc`; clones
 *   the page's own document when omitted. No scope — only meaningful where a page DOM exists,
 *   same as `ui`, but fails with a plain error rather than a crafted stub elsewhere.
 * - `synapseApi.lib.toMarkdown(root: Node, options: { baseUrl, resolveImageUrl? }): string` — no scope required — pure computation (runs in your own world — synchronous).
 *   Convert a DOM subtree to Markdown. No scope: pure computation on a Node the caller already
 *   has.
 * - `synapseApi.lib.zip(entries: { name, data }[]): Uint8Array` — no scope required — pure computation (runs in your own world — synchronous).
 *   Build an uncompressed .zip archive from named byte buffers. No scope: pure computation.
 * - `synapseApi.lib.matchPattern.isValid(pattern: string): boolean` — no scope required — pure computation (runs in your own world — synchronous).
 *   Whether pattern is well-formed Chrome match-pattern syntax. No scope: pure computation.
 * - `synapseApi.lib.matchPattern.test(url: string, pattern: string): boolean` — no scope required — pure computation (runs in your own world — synchronous).
 *   Whether url falls under pattern - the exact matcher net.request/net.mock enforce against. No
 *   scope: pure computation.
 * - `synapseApi.lib.matchPattern.testAny(url: string, patterns: string[]): boolean` — no scope required — pure computation (runs in your own world — synchronous).
 *   Whether url falls under any of patterns. No scope: pure computation.
 */

/**
 * A permission a script can be granted. Named after the purpose/resource, never after the
 * transport mechanism — a script declares what it wants to *do*, not which pipe it wants. `bus` is
 * deliberately absent and can never become a scope: `bus.emit(moduleId, …)` reaches every bundled
 * Module's own listener, which is a god-capability no consent prompt can describe honestly.
 */
type SynapseScope = 'storage.rw' | 'page.dom' | 'page.fetch' | 'ui.render' | 'net.request' | 'files.save' | 'net.mock' | 'net.mock.debugger' | 'media' | 'page.eval' | 'secrets.use';

/**
 * One entry in a script's `scopes` declaration. `match` is the resource dimension: a grant is
 * (action × origin), the same shape as Tampermonkey's `@connect`. No scope requires it yet — the
 * network-touching scopes that will (docs/ROADMAP.md §11.3 constraint B, §11.6) arrive in Phase 5 —
 * but grants are persisted in this shape from the start so adding one is not a second data
 * migration. A bare string is accepted as shorthand for `{ scope }`.
 */
interface SynapseScopeGrant {
  scope: SynapseScope;
  /** Match patterns (`*://*.example.com/*`) limiting which origins the scope applies to. */
  match?: string[];
}

/** Plain key/value operations, shared shape across all three storage lifetimes below — they differ
 * only in when the platform evicts the keys, never in the read/write surface. */
interface SynapseKeyValueApi {
  /** Resolves to `undefined` when this script has never written `key`. */
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  /** Every key this script has written, without the internal namespace prefix. */
  keys(): Promise<string[]>;
}

/** Per-script key/value storage. Keys are namespaced to the calling script by the platform and
 * there is no way for a key to escape that namespace — see `scopes.ts` for why that is the
 * precondition of the whole permission model rather than a nicety. Scope: `storage.rw` for all
 * three sub-namespaces below (docs/ROADMAP.md Track A2) — they differ in *lifetime*, not in
 * *permission*, so no new scope was minted for `session`/`tab`.
 *
 * The root object itself (`get`/`set`/`remove`/`keys`) is the **permanent** lifetime — never
 * evicted by the platform, until the script itself calls `remove()` or is deleted. Kept flat
 * (not nested under e.g. `.local`) for backward compatibility: this is the original v1 shape. */
interface SynapseStorageApi extends SynapseKeyValueApi {
  /** Dies when the calling tab CLOSES — survives navigation/reload within that tab. Only usable
   * from code attached to a real tab (a dom Module or an uploaded script); a background Module has
   * no tab of its own and gets a stub whose every method rejects, same posture as `page`/`ui`. */
  tab: SynapseKeyValueApi;
  /** Dies on the calling tab's next navigation commit, **including a reload of the same URL** —
   * the same "navigation" lifetime the platform's own detected-media list uses internally
   * (docs/ROADMAP.md Track A1). Same tab-only restriction and stub behavior as `tab` above. */
  session: SynapseKeyValueApi;
}

/**
 * In-page UI, allocated and positioned by the platform's compositor. Scope: `ui.render`.
 *
 * **Synchronous, and closures are welcome** — unlike every other namespace here, this one never
 * sends a message. The engine runs in your own world (docs/ROADMAP.md §11.0), so `onClick` is a
 * real function call, not a serialized action id.
 *
 * You never receive a node in shared space, and ids are local to your script: `toast({id:'x'})` from
 * two different scripts creates two different toasts, and there is no way to name — let alone
 * remove — another script's surface. Every method returns `false` when the call was refused (quota
 * exhausted or toast rate limit), never a silent no-op. The user hiding this script's UI is not a
 * refusal: the surface is created and returns `true`, it is simply not displayed until they unhide,
 * at which point everything drawn in the meantime appears at once.
 */
interface SynapseUiApi {
  /** Card, bottom-right. Reusing an id updates that card in place instead of stacking. */
  toast(options: { id: string; message: string; actionLabel?: string; onAction?: () => void }): boolean;
  /** Persistent round button, top-right. Max 2 per script. */
  icon(options: { id: string; label: string; title?: string; onClick: () => void }): boolean;
  /** Small button pinned to a page element's corner, following it until it leaves the document. */
  badge(options: { id: string; target: Element; label: string; title?: string; onClick: () => void }): boolean;
  dismiss(kind: 'toast' | 'icon' | 'badge', id: string): void;
  /** Removes everything this script has drawn. */
  clear(): void;
}

/** A `net.request` header value naming a secret by reference instead of carrying it directly
 * (docs/ROADMAP.md §11.6's Secret Service) — the script declares which secret it wants and how to
 * shape the header around it, and never receives the resolved value in any form. `format` lets the
 * header be more than the bare secret (`'Bearer {}'`); `{}` is replaced with the resolved value at
 * the network boundary. Defaults to `'{}'` (the raw value). Requires the `secrets.use` scope in
 * addition to `net.request` itself — and even then, the referenced secret's own `allowedHost`
 * (bound once, at creation, in the Dashboard) must independently match `url`, regardless of what
 * `net.request`'s own `match` grant allows. */
interface SynapseNetSecretHeaderValue {
  secretRef: string;
  format?: string;
}

/** One outbound request for `net.request`. `match` in the granted scope is checked against `url`
 * before this ever reaches the network — a URL that doesn't fall under one of the script's granted
 * patterns fails at the call site, same as any other denied scope. */
interface SynapseNetRequestOptions {
  url: string;
  /** Defaults to `'GET'`. */
  method?: string;
  /** A value may be a plain string, or `{ secretRef, format? }` to have the platform inject a named
   * secret (`secrets.use`) without this script ever seeing it. */
  headers?: Record<string, string | SynapseNetSecretHeaderValue>;
  /** Must survive structured clone: a string, never a live body stream. Binary payloads go through
   * `bodyEncoding: 'base64'`, the same convention `shared/http-mock.ts`'s `bodyEncoding` uses. */
  body?: string;
  /** How `body` is encoded. Defaults to `'utf8'`. */
  bodyEncoding?: 'utf8' | 'base64';
  /** `'text'` (default) decodes the response as UTF-8 text; `'arraybuffer'` returns it
   * base64-encoded in the response's `body`, for binary responses (images, zips). */
  responseType?: 'text' | 'arraybuffer';
  /** Defaults to 30s, capped at 120s. */
  timeoutMs?: number;
}

/** What `net.request` resolves to on any HTTP response, including 4xx/5xx — those are not thrown,
 * the same way `fetch()` itself only rejects on a network failure, never a non-2xx status. */
interface SynapseNetResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Encoded per `responseType`: UTF-8 text when `'text'`, base64 when `'arraybuffer'` — check
   * `bodyEncoding` rather than assuming, since it reflects what was actually requested. */
  body: string;
  bodyEncoding: 'utf8' | 'base64';
  /** The final URL after any redirects. */
  url: string;
}

/** One rule for `synapseApi.mock.add` (docs/api-inventory.md §3.2). `endpointPattern` must have a
 * literal (non-wildcard) scheme and host under one of this call's granted `net.mock` `match`
 * patterns — only the path may use `*` (`https://api.example.com/*`, never `*://*.example.com/*`);
 * a wildcarded scheme/host is rejected at the grant check, the same fail-closed answer a mismatched
 * origin gets. `method` mirrors `shared/http-mock.ts`'s `HttpMethod`, duplicated (not imported) per
 * this file's own import-free constraint — `'ALL'` (the default) matches every method. */
interface SynapseMockRuleOptions {
  endpointPattern: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ALL';
  /** What the rule does once it matches (docs/ROADMAP.md Track B2a/B2b) — the platform still picks
   * *how* (`chooseMechanismForScriptRule`, shared/http-mock.ts), this only ever declares intent.
   * Defaults to `'fake-response'`, the only action v1 (pre-Track-B2) had. */
  action?: 'fake-response' | 'rewrite-request' | 'block';
  /** Only meaningful for `action: 'fake-response'`. HTTP status to answer with. Defaults to 200. */
  fakeStatus?: number;
  /** Only meaningful for `action: 'fake-response'`. A string is sent as-is; anything else is
   * JSON-serialized. */
  fakeResponse?: unknown;
  /** Only meaningful for `action: 'rewrite-request'`. Overrides the request's URL before it is sent.
   * Omitted fields keep the original request's value. */
  rewriteUrl?: string;
  /** Only meaningful for `action: 'rewrite-request'`. */
  rewriteMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Only meaningful for `action: 'rewrite-request'`. Merged into the outgoing request's headers. */
  rewriteHeaders?: Record<string, string>;
  /** Only meaningful for `action: 'rewrite-request'`. Overrides the request body. Setting this is
   * what can push the resolved mechanism to `'debugger'` when combined with `matchAnyResourceType`
   * — see that field's own doc comment. */
  rewriteBody?: string;
  /** Only meaningful for `action: 'rewrite-request'` or `'block'`. Declares that this rule must also
   * catch requests NOT made via `fetch`/XHR (an `<img>`/`<script>` tag, for example) — `'block'`
   * already gets this for free from `'dnr'`, no extra grant needed; for `'rewrite-request'` WITH
   * `rewriteBody` set, this is the one combination only the `debugger` mechanism can do, which
   * additionally requires the `net.mock.debugger` scope to be granted. Omit (or leave `false`) to
   * stay scoped to `fetch`/XHR-originated requests only, the cheaper and more common case. */
  matchAnyResourceType?: boolean;
  /** Only meaningful for `action: 'fake-response'`. Answers this many milliseconds late, to test
   * loading states. */
  delayMs?: number;
}

/** What `mock.list()` returns for one of this script's own rules — the same fields `add` accepted,
 * echoed back with the id it was assigned (docs/ROADMAP.md Track B2b — no longer fixed to
 * fake-response/main-world, `action` reflects what was actually declared). */
interface SynapseMockRule {
  id: string;
  endpointPattern: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ALL';
  action: 'fake-response' | 'rewrite-request' | 'block';
  fakeStatus?: number;
  fakeResponse?: unknown;
  rewriteUrl?: string;
  rewriteMethod?: string;
  rewriteHeaders?: Record<string, string>;
  rewriteBody?: string;
  delayMs?: number;
}

/**
 * Fakes, rewrites, or blocks matching requests instead of letting them reach the network unchanged
 * — for testing error handling or working against an API that doesn't exist yet. Scope: `net.mock`,
 * always carries `match`.
 *
 * A script declares *what* it wants via `action` (docs/ROADMAP.md Track B2a/B2b); it never picks
 * *how* that's intercepted — the platform always resolves the cheapest mechanism able to do the job
 * (`chooseMechanismForScriptRule`, shared/http-mock.ts): `'fake-response'` and most `'rewrite-request'`
 * calls never leave a MAIN-world `fetch`/`XMLHttpRequest` patch (no DevTools "being debugged" banner);
 * `'block'` always resolves to `chrome.declarativeNetRequest` (native, no banner, catches every
 * resource type). The ONE combination that reaches `chrome.debugger` — a `'rewrite-request'` with
 * `rewriteBody` AND `matchAnyResourceType` both set — additionally requires the `net.mock.debugger`
 * scope to be granted; every other call here only ever needs `net.mock` itself.
 */
interface SynapseNetMockApi {
  add(options: SynapseMockRuleOptions): Promise<{ id: string }>;
  /** Removes one of your own rules. An id belonging to another script, or to a rule created by hand
   * in the Management View, is refused — ids are not a capability, ownership is checked server-side. */
  remove(id: string): Promise<void>;
  /** Every rule this script has added, never another script's or the user's own. */
  list(): Promise<SynapseMockRule[]>;
}

/** Fetches under the extension's own identity — not the page's — so it is not subject to the
 * page's CORS policy (that's `page.fetch`, disclosed, unchanged). Scope: `net.request`, and every
 * grant carries `match`: a script can only reach the origins it declared, the same (action × origin)
 * shape as Tampermonkey's `@connect`. */
interface SynapseNetApi {
  request(options: SynapseNetRequestOptions): Promise<SynapseNetResponse>;
  mock: SynapseNetMockApi;
}

/** One file to write to disk. Scope: `files.save` — the delta a script cannot close on its own
 * (`GM_download` in the Tampermonkey world; there is no page API that writes to the filesystem). */
interface SynapseFilesSaveOptions {
  /** Relative to the browser's Downloads folder; may include subfolders (`'exports/x.json'`).
   * Never an absolute path or a `..` segment — rejected before this reaches `chrome.downloads`. */
  filename: string;
  /** Must survive structured clone: a string, never a live Blob/stream. Binary content goes through
   * `contentEncoding: 'base64'`, the same convention `net.request`'s body/response use. */
  content: string;
  /** Defaults to `'utf8'`. */
  contentEncoding?: 'utf8' | 'base64';
  /** Defaults to `'text/plain;charset=utf-8'` for utf8 content, `'application/octet-stream'` for
   * base64 content. */
  mimeType?: string;
  /** Prompts the user for a save location instead of writing straight to `filename`. Defaults to
   * `false`. */
  saveAs?: boolean;
}

interface SynapseFilesSaveResult {
  /** Chrome's own download id — usable with `chrome://downloads` but not with any `synapseApi`
   * method today; there is no `files.*` follow-up call yet (no progress/cancel). */
  downloadId: number;
}

interface SynapseFilesApi {
  save(options: SynapseFilesSaveOptions): Promise<SynapseFilesSaveResult>;
}

/** One variant listed by an HLS master playlist — itself another manifest URL, not a video. */
interface SynapseHlsManifestVariant {
  url: string;
  /** From `RESOLUTION=WxH`. Absent when the playlist doesn't advertise one (e.g. audio-only). */
  resolution?: string;
}

/** One `#EXT-X-KEY` tag's worth of info. `method !== 'AES-128'`, or any `keyFormat` other than
 * absent/`'identity'`, means real DRM (Widevine/PlayReady/FairPlay) — not something to decrypt. */
interface SynapseHlsSegmentKey {
  method: string;
  uri: string;
  iv?: string;
  keyFormat?: string;
}

interface SynapseHlsManifestSegment {
  url: string;
  key?: SynapseHlsSegmentKey;
  byteRange?: string;
}

/** What `lib.hls.parse` returns — mirrors `shared/media-manifest-parser.ts`'s `ParsedManifest`
 * exactly (duplicated here, not imported: this file must stay import-free, see the file banner). */
type SynapseHlsManifest =
  | { kind: 'master'; variants: SynapseHlsManifestVariant[] }
  | {
      kind: 'media';
      segments: SynapseHlsManifestSegment[];
      /** The init segment of a fragmented-MP4 (CMAF) stream — `undefined` for MPEG-TS. */
      initSegment?: SynapseHlsManifestSegment;
      encrypted: boolean;
      isLive: boolean;
      mediaSequence: number;
      targetDurationSec?: number;
    }
  | { kind: 'unknown' };

/**
 * Pure computation on data the caller already has in hand — no privilege granted, no scope, no
 * message ever sent (docs/api-inventory.md §3.0). `lib.*` exists purely to save a script from
 * re-implementing something Synapse's own builtins already had to get right (here: the HLS
 * media-playlist parser `download`'s decrypt/remux engine relies on, docs/ROADMAP.md §8.4).
 *
 * Reachable from every context — unlike `ui`, which needs a page. Synchronous, like `ui`, for the
 * same reason: there is no transport boundary to cross, so there is nothing to `await`.
 */
interface SynapseLibApi {
  hls: {
    /** `baseUrl` resolves the manifest's relative URIs (segments, variants, keys) to absolute
     * ones — pass the URL the manifest text was fetched from. */
    parse(text: string, baseUrl: string): SynapseHlsManifest;
  };
  /** Extracts the readable article from a page-like `Document`, via Mozilla's Readability — the
   * same engine behind Firefox's Reader View, and the same one `reader-mode-converter`'s builtin
   * uses. **Mutates `doc`**; pass a clone if the original must stay untouched. Omit `doc` to have
   * Synapse operate on a clone of the current page's own `document` for you. Returns `undefined`
   * when Readability decides the page isn't an article — same "no privilege, honest primitive"
   * posture as the rest of `lib.*`: this never guesses a fallback for you. Only meaningful where a
   * `Document` exists; calling with no `doc` from a context with no page (a background Module)
   * fails with a plain `ReferenceError`, not a crafted message — there is nothing privileged being
   * denied, just a missing input. */
  readable(doc?: Document): { title: string; root: Element; text: string } | undefined;
  /** Converts a DOM subtree to Markdown (mixmark-io/turndown under the hood) — the same converter
   * `reader-mode-converter` uses. `root` is typically `lib.readable(...)`'s `root`, but any Node
   * works; `options.resolveImageUrl` lets you point image links at local copies you've already
   * `net.request`-ed instead of the original remote URL. */
  toMarkdown(root: Node, options: { baseUrl: string; resolveImageUrl?: (absoluteUrl: string) => string }): string;
  /** Builds an uncompressed (STORE method) `.zip` archive from named byte buffers — hand-rolled,
   * no dependency (docs/ROADMAP.md §1). Pass the result to `files.save` with
   * `contentEncoding: 'base64'` to write it to disk. */
  zip(entries: { name: string; data: Uint8Array }[]): Uint8Array;
  /** Chrome extension match-pattern syntax (`*://*.example.com/*` — the same shape `net.request`'s
   * `match` grants use, and Tampermonkey's `@connect`). Pure, no scope: this is the exact matcher
   * `net.request`/`net.mock` are enforced against, exposed rather than re-implemented, because its
   * edge cases (the `*.` subdomain-wildcard rule, `*` as scheme meaning http/https only) are easy to
   * get subtly wrong and NOT the same rules a standard `URLPattern` follows. Useful to pre-filter a
   * batch of candidate URLs against your own declared `match` list before firing `net.request` for
   * each one, instead of discovering the rejection at the call site one at a time. */
  matchPattern: {
    /** Whether `pattern` itself is well-formed Chrome match-pattern syntax. */
    isValid(pattern: string): boolean;
    /** Whether `url` falls under `pattern`. An unparseable `url` or `pattern` never matches. */
    test(url: string, pattern: string): boolean;
    /** Whether `url` falls under any of `patterns`. */
    testAny(url: string, patterns: string[]): boolean;
  };
}

/** A `synapseApi.media.list()`/`.download()`-eligible file the network sniffer already detected —
 * mirrors `features/media/store.ts`'s `DetectedMedia` (duplicated here, not imported: this file
 * must stay import-free, see the file banner), trimmed to the fields a script has any use for.
 * `requestHeaders` is deliberately excluded: it exists so Synapse's OWN later fetch of this URL can
 * replay a handful of allowlisted headers, not something a script needs to see or act on. */
interface SynapseMediaEntry {
  id: string;
  url: string;
  kind: 'video' | 'audio' | 'stream';
  pageUrl?: string;
  tabUrl?: string;
  /** ISO timestamp — display-only; list order is detection order. */
  detectedAt: string;
  thirdParty?: boolean;
  /** Best-effort signal the URL carries a signed/expiry query param (S3-style presigned URL, CDN
   * token-auth, …) — a label, not a filter: a legitimate file being served this way is normal. */
  expiring?: boolean;
  resolution?: string;
  /** Set once a `kind: 'stream'` entry has been auto-inspected and turned out to be a media/variant
   * playlist (not a master listing other resolutions) — segment count only, not the segment URLs
   * themselves (those are hundreds-long and go stale the moment a live manifest rotates). */
  segmentCount?: number;
  /** Set alongside `segmentCount` — real DRM (not the AES-128-with-clear-key case `media.download`
   * can handle), same distinction `SynapseHlsSegmentKey` documents for `lib.hls.parse`. */
  encrypted?: boolean;
  /** Set on a master-playlist `kind: 'stream'` entry once auto-inspected — one variant per
   * resolution the master lists, each its own downloadable media-playlist URL. */
  variants?: { url: string; resolution?: string }[];
}

/** What `media.inspect(url)` resolves to for an HLS (`.m3u8`) URL — a fresh fetch+parse, not a
 * cached read, so it reflects the manifest as it is right now. A master playlist populates only
 * `variants`; a media/variant playlist populates the rest; a URL that isn't parseable HLS resolves
 * to `{}` (all fields absent) — the same "honest primitive, no crafted fallback" posture as
 * `lib.readable`. DASH (`.mpd`) is out of scope, same as `lib.hls.parse` (docs/api-inventory.md §3.1). */
interface SynapseMediaInspectResult {
  /** Present only for a master playlist — each entry is another resolution's own media-playlist URL. */
  variants?: { url: string; resolution?: string }[];
  /** Present only for a media/variant playlist — segment count, not the segment URLs themselves. */
  segments?: number;
  encrypted?: boolean;
  /** A sliding-window (no `#EXT-X-ENDLIST`) playlist — `media.download` on one of these keeps
   * capturing until `media.control(jobId, 'stop-live')`, never reaching `'done'` on its own. */
  live?: boolean;
}

interface SynapseMediaDownloadOptions {
  url: string;
  /** Cosmetic label (e.g. `"1080p"`) — carried through to `media.job()`'s status for display only. */
  resolutionLabel?: string;
}

/** Mirrors the download engine's own phase names (`shared/download-engine-protocol.ts`'s
 * `DownloadEnginePhase`, duplicated here per this file's import-free constraint). `'pausing'` is the
 * honest in-between state between a `'pause'` control call and the engine actually reaching a quiet
 * point — up to one segment/chunk can still be genuinely in flight when the request arrives. */
type SynapseMediaDownloadPhase = 'segments' | 'chunks' | 'remux' | 'pausing' | 'paused' | 'done' | 'error' | 'cancelled';

/** What `media.job(jobId)` resolves to — a snapshot, not a subscription (docs/api-inventory.md §4:
 * a function-valued `onProgress` callback cannot cross the RPC boundary, so polling is the v1 answer
 * for every job-shaped API). `undefined` means this platform has no snapshot for `jobId` — either it
 * was never started via `media.download`, or the background service worker restarted since (the
 * snapshot is in-memory only, same "no persistence" posture `docs/ROADMAP.md §7.6` already commits
 * to for download progress). */
interface SynapseMediaJobStatus {
  phase: SynapseMediaDownloadPhase;
  done?: number;
  total?: number;
  /** Set only when `phase === 'error'`. */
  error?: string;
}

type SynapseMediaControlAction = 'pause' | 'resume' | 'cancel' | 'stop-live';

/**
 * Detect → inspect → download → poll → control, over media the network sniffer already found on
 * pages this script (or any other) ran on. Scope: `media`, no `match` dimension — unlike
 * `net.request`/`net.mock`, a grant is all-or-nothing, not scoped per origin (docs/api-inventory.md
 * §5: a script asking to see detected media is asking to see all of it, the same way the Side Panel
 * does).
 *
 * `download`/`job`/`control` are the id-based facade docs/api-inventory.md §3.1 calls for: the
 * engine itself deals in live objects (`AbortController`, an OPFS run) that cannot cross structured
 * clone, so every one of these methods takes or returns a plain `jobId` string instead.
 */
interface SynapseMediaApi {
  /** Every media file detected so far, most-recently-seen order. Same list the Side Panel shows. */
  list(): Promise<SynapseMediaEntry[]>;
  /** Fetches and parses an HLS manifest URL fresh — typically one of `list()`'s own entries, or one
   * of a master entry's `variants`. */
  inspect(url: string): Promise<SynapseMediaInspectResult>;
  /** Starts a download and returns its `jobId` immediately — does not wait for completion. Poll
   * `job(jobId)` for progress. `url` must classify as media by extension (`.m3u8`/`.mpd` run the
   * HLS/segment engine; `.mp4`/`.webm`/`.mp3`/… run the multi-connection direct-file downloader) —
   * anything else is refused before a job is created. */
  download(options: SynapseMediaDownloadOptions): Promise<string>;
  /** A snapshot of `jobId`'s current progress, or `undefined` if there is none to report (see
   * `SynapseMediaJobStatus`'s own doc comment for why "none" is a legitimate, non-error answer). */
  job(jobId: string): Promise<SynapseMediaJobStatus | undefined>;
  /** Acts on a job started by `download()`. `'stop-live'` only makes sense for a live capture (a
   * sliding-window manifest with no `#EXT-X-ENDLIST`) and is a no-op otherwise. */
  control(jobId: string, action: SynapseMediaControlAction): Promise<void>;
  /**
   * Push updates for a job started by `download()`, instead of polling `job()` — the first real
   * consumer of the subscription mechanism docs/api-inventory.md §4 spiked (§6 item 8).
   * **Synchronous, and takes a closure — like `ui`, not like the rest of `media`**: this never
   * crosses the RPC boundary (a function-valued `handler` cannot survive structured clone), so the
   * platform registers it in your own world and only ever pushes the already-serializable
   * `SynapseMediaJobStatus` across. Returns an unsubscribe function.
   *
   * **Delivery into the USER_SCRIPT world is confirmed working on real Chrome** — the platform CAN
   * push into that world (docs/api-inventory.md §6 item 8's write-up has the mechanism); `job(jobId)`
   * polling remains available as a fallback (a background service-worker restart between the push
   * and your handler still loses in-flight events, same as any other in-memory-only state here), but
   * is no longer the only working path.
   */
  onProgress(jobId: string, handler: (status: SynapseMediaJobStatus) => void): () => void;
}

/**
 * Runs `code` directly in the page's own MAIN-world JS context — Tampermonkey's `unsafeWindow`,
 * made an explicit call instead of an ambient global (docs/api-inventory.md §2, §6 item 7). Scope:
 * `page.eval`, always carries `match` — but unlike every other `requiresMatch` scope, the resource
 * checked is not something passed as an argument: it is whichever tab this call is actually running
 * on, read from the platform's own record of the sender, so a script cannot claim a different origin
 * than the one it is really calling from.
 *
 * The highest-privilege scope in the catalog and the only one with no partial version: once granted
 * for a domain, `code` runs with the full authority of that page's own JS context — every global,
 * every cookie-backed fetch, every DOM mutation a hand-authored `<script>` tag on that page could
 * do. There is no sandboxing inside `code` itself.
 *
 * Same structured-clone rules as every other `rpc` method (see the file banner): `args` and
 * whatever `code` `return`s must both survive it — no functions, no DOM nodes, no live objects.
 * `code` runs as the body of an async function, so `await` works inside it.
 *
 * **Best-effort, not a bypass**: a page whose `script-src` CSP excludes `unsafe-eval` will reject
 * the `Function` construction this relies on, and the call rejects with that page's own CSP error
 * instead of running — v1 has no workaround for that (docs/api-inventory.md §7).
 */
interface SynapsePageApi {
  /** Runs synchronously to the extent `code` itself is synchronous, but always resolves the same
   * way `net.request` etc. does: an async round trip, whether or not `code` itself awaits anything.
   * `args` are passed through as `code`'s own `args` parameter. */
  eval(code: string, args?: unknown[]): Promise<unknown>;
}

/** The two providers `ai.ask` speaks natively (docs/ROADMAP.md §11.6). Deliberately NOT an
 * extensible string: "unified LLM interface" is the hole this method exists to avoid — anything
 * beyond these two shapes is `net.request` + `secretRef`, not a third branch grafted on here. */
type SynapseAiProvider = 'openai' | 'ollama';

interface SynapseAiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface SynapseAiAskOptions {
  provider: SynapseAiProvider;
  model: string;
  messages: SynapseAiMessage[];
  /** Names a secret (`secrets.use`) whose value is injected as `Authorization: Bearer <value>` at
   * the network boundary — this script never sees it, same mechanism `net.request`'s own
   * `{secretRef}` header value uses. Required for `'openai'` (no key, no request); ignored for
   * `'ollama'` (a local server, no auth) even if given. */
  secretRef?: string;
  /** Overrides the provider's default endpoint — a self-hosted Ollama on a non-default host/port,
   * or an OpenAI-compatible proxy. Still checked against this call's own granted `net.request`
   * `match` (see `SynapseAiApi`'s doc comment on why that's the gating scope). Defaults:
   * `'https://api.openai.com/v1/chat/completions'` (openai), `'http://localhost:11434/api/chat'`
   * (ollama). */
  baseUrl?: string;
  /** Defaults to 30s, capped at 120s — same cap as `net.request`. */
  timeoutMs?: number;
}

interface SynapseAiAskResult {
  text: string;
}

/**
 * `{provider, model, messages} → text` — a thin helper over the two chat-completion shapes worth
 * saving a script from re-typing by hand, not an agent and not a unified abstraction over every LLM
 * API (docs/ROADMAP.md §11.6). No scope of its own: gated on `net.request`, the same scope a script
 * would need to call the provider's endpoint directly — `ai.ask` only shapes the request and
 * extracts the reply text, it does not open a door `net.request` + `secretRef` didn't already open,
 * so it does not get a second one.
 *
 * **v1 does not stream.** `chrome.runtime.sendMessage`'s reply is one value, not a stream — a
 * streaming variant would need `chrome.runtime.connect`, not attempted here.
 */
interface SynapseAiApi {
  ask(options: SynapseAiAskOptions): Promise<SynapseAiAskResult>;
}

/**
 * Tier 2 composition (docs/ROADMAP.md §11.6 item 8, `.claude/skills/userscript-api` "Composition"):
 * a platform pipeline declares a named *slot*; a script overrides it for the pages it cares about
 * via `match`, instead of forking the whole feature. **Synchronous-feeling but takes a closure —
 * like `ui`/`media.onProgress`, not like the rest of the facade**: `handler` never crosses the RPC
 * boundary (a function-valued parameter cannot survive structured clone), so it runs entirely in
 * your own world, and only its already-serializable *return value* is relayed back to the platform.
 *
 * **Conflict rule** when more than one script hooks the same slot for an overlapping URL: the more
 * specific `match` pattern wins; a tie breaks by script order the user has configured (today: a
 * placeholder — no such setting exists yet, see docs/ROADMAP.md); registration order never decides
 * anything.
 *
 * v1 has exactly one slot. Extend `SynapsePipelineHookOptions`'s `slotName`/ctx/result union when a
 * second one ships — do not generalize ahead of a second real caller.
 */
interface SynapseMediaCorrelateUrlCtx {
  /** The page this slot fired on — match your `handler`'s own site-specific logic against this,
   * not against `location.href` read fresh (the two are the same value here, but reading the one
   * you were given is what makes a future slot with a different `ctx` shape safe to add without
   * silently changing this one's contract). */
  pageUrl: string;
}

interface SynapseMediaCorrelateUrlResult {
  /** CSS selector identifying the `<video>`/`<audio>` element this `url` belongs to. Re-resolved by
   * the platform against the live page DOM after `handler` returns — the element itself never
   * crosses the world boundary, only this selector does. An entry whose selector no longer resolves
   * (the page changed between fire and response) is skipped, not an error. */
  cssSelector: string;
  url: string;
}

interface SynapsePipelineHookOptions {
  match: string[];
  /** Called with the fired slot's `ctx` when this script wins the conflict resolution for the
   * current page. Return the media URLs your own site-specific logic found — an empty array or a
   * thrown error both mean "nothing found", never a hang (see `pipeline.hook`'s own doc comment on
   * `SynapsePipelineApi`). */
  handler: (ctx: SynapseMediaCorrelateUrlCtx) => SynapseMediaCorrelateUrlResult[] | Promise<SynapseMediaCorrelateUrlResult[]>;
}

interface SynapsePipelineApi {
  /** Registers `options.handler` for `slotName` on the pages matched by `options.match`. Resolves
   * once the registration is accepted (rejects if the required scope — reused from whichever
   * feature owns the slot, `media` for `'media.correlate-url'` — isn't granted) to an unsubscribe
   * function; call it to release the slot early (a fresh page load re-registers anyway, since
   * top-level script code runs again on every navigation). */
  hook(slotName: 'media.correlate-url', options: SynapsePipelineHookOptions): Promise<() => void>;
}

/** The facade every caller programs against, delivered as `ctx.api`: to bundled Modules from the
 * Kernel, to uploaded user scripts from the shim. One interface, three transports (in-process /
 * content-script RPC / user script shim) — a method reachable from one but not another is a
 * contract break, not a gap. Deliberately never a global: uploaded scripts share one execution
 * world, so a global name has one binding for all of them and could not identify the caller. */
interface SynapseApi {
  storage: SynapseStorageApi;
  /** Only usable from code that runs on a page. A background Module gets a stub whose every method
   * throws with that explanation — there is no DOM in a service worker to render into. */
  ui: SynapseUiApi;
  net: SynapseNetApi;
  files: SynapseFilesApi;
  lib: SynapseLibApi;
  media: SynapseMediaApi;
  /** Only usable from code that runs on a page, same as `ui` — a background Module gets a stub
   * whose method throws with that explanation, since "the page's MAIN world" has no meaning for
   * code that isn't attached to any tab. */
  page: SynapsePageApi;
  ai: SynapseAiApi;
  pipeline: SynapsePipelineApi;
}

/** One step of a multi-step script (docs/ROADMAP.md §12.3) — the uploaded-script equivalent of a
 * bundled Composite Module's sub-module (`kernel/composite-module.ts`). Steps run in array order,
 * each one's resolved value becoming the next one's `input`, exactly like `createCompositeModule`:
 * sequential only, no rollback — a step that throws is reported (Studio's sidebar shows which one
 * and why) and the NEXT step still runs with the previous value unchanged. */
interface SynapseUserScriptStep {
  /** Stable identity for this step. Prefer a short literal string constant (e.g. `'load-dom'`):
   * the Studio sidebar locates a step's definition by searching your saved source text for this
   * exact literal to jump the editor to it, so an id computed at runtime can be listed but never
   * jumped to. Also the key for this step's per-run bypass toggle (`RegistryEntry.subState`). */
  id: string;
  /** Shown in the Studio sidebar and the popup's tooltip instead of the raw id. */
  label?: string;
  run(input: unknown, ctx: { api: SynapseApi }): Promise<unknown>;
}

/** What an uploaded user script assigns to `__synapseModule` to declare itself. Assign the bare
 * name, not `globalThis.__synapseModule` — both create the same global at runtime (the shim wraps
 * user source in a non-strict IIFE, so a bare undeclared assignment becomes an implicit global same
 * as `globalThis.x =` would), but only the bare form gets contextual typing from this file when
 * loaded into an editor via TS's `addExtraLib` (`declare let __synapseModule: ...` below doesn't
 * attach to `globalThis`'s type — a top-level `let`/`const` never does, matching real JS semantics). */
interface SynapseUserScriptManifest {
  /** Display label only. The extension assigns the canonical routing id at upload time, before
   * this script has ever run, so this can never be a routing or storage key. */
  id: string;
  /** Requested scopes. This is a *request*: the grant record the user approved is the authority,
   * and it is re-checked in the background on every single call. */
  scopes?: (SynapseScope | SynapseScopeGrant)[];
  /**
   * Declare exactly one of `run`/`steps` (docs/ROADMAP.md §12.3) — declaring both, or neither, is
   * `invalid`. A bare `run` is really `steps: [{ id: 'main', run }]` in disguise: the platform
   * normalizes it to that shape internally, so every uploaded script is "a pipeline of N≥1 steps"
   * from the Registry's point of view, and the single-step case is not a special case anywhere
   * downstream. Declare `steps` directly once your script grows past one logical stage — the
   * Studio sidebar then shows each step's last run status and lets the user bypass it individually,
   * without touching this file's `run`.
   */
  run?(input: unknown, ctx: { api: SynapseApi }): Promise<unknown>;
  /** Two or more steps, each with a unique `id`. See `run`'s doc comment above — declare one or
   * the other, never both. */
  steps?: SynapseUserScriptStep[];
}

/**
 * Assign this to declare your script. `scopes` is a *request*: the extension re-checks the grant
 * the user approved on every call, so a scope you declared but the user denied fails at the call,
 * not at load.
 *
 * The API arrives as `run()`'s `ctx.api` — there is deliberately **no** `synapseApi` global.
 * Every uploaded script shares one execution world, so a global has a single binding for all of
 * them and cannot tell the platform which script is calling; the last script loaded would own the
 * name and everyone else's calls would run under its identity and its permissions. To use the API
 * outside `run()`, capture it: `let api; …async run(input, ctx) { api = ctx.api; }`.
 * (The name `synapseApi` does exist in that world, but every method on it rejects with this
 * explanation — a loud failure instead of a silent impersonation.)
 */
declare let __synapseModule: SynapseUserScriptManifest;
```
