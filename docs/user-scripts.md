# Uploaded Modules (User Scripts)

Synapse lets you upload a plain `.js` file from the extension popup and run it as a Module,
Tampermonkey-style — without rebuilding the extension. This is possible because Manifest V3's
CSP blocks arbitrary `eval`/dynamic `import()` in privileged contexts; the only sanctioned way to
run user-supplied code is [`chrome.userScripts`](https://developer.chrome.com/docs/extensions/reference/api/userScripts),
which executes your script in an isolated `USER_SCRIPT` world, separate from both the page and
the extension's own background/content-script contexts.

## Enabling uploads

Chrome requires you to manually allow this per install: open `chrome://extensions`, find Synapse,
open its details page, and enable **"Allow User Scripts"**. Without this, uploads register but
your script can never reach the extension's messaging bridge (`chrome.userScripts.configureWorld`
fails silently in the background — check the service worker console).

## Writing a script

Because there's no bundler step for an uploaded file, there's no `import` — declare your module
via two globals instead:

```javascript
globalThis.__synapseModule = {
  id: 'my-module', // display name only — see "Identity" below
  needs: ['cache'], // capabilities you want; omit or [] for none
  async run(input, ctx) {
    await synapse.cache.set('last-input', input);
    return await synapse.cache.get('last-input');
  },
};
```

`synapse.{ai,cache,bus}` and `__synapseModule` are plain globals the extension injects around
your code before registering it — see [`docs/types/synapse-userscript.d.ts`](types/synapse-userscript.d.ts)
for their full shape (reference it in your own editor for autocomplete; it has no effect on the
extension itself).

## Identity

`chrome.userScripts.register()` needs a script id *before* your code has ever run, so the
extension assigns its own id (a UUID) at upload time — that's the canonical id used for
activation, capability grants, and RPC routing. Your `__synapseModule.id` is read back after your
script's first execution and shown as a friendly label in the popup, but it never affects
routing or storage keys.

## Capabilities and grants

Declaring `needs: ['cache']` is not enough on its own — every `synapse.*` call is checked by the
background service worker against capabilities you've explicitly granted via the popup's "Grant"
button. Because your script's `needs` isn't known until after its first run, the very first
execution may have its `synapse.*` calls rejected; open the popup afterward to grant what it
asked for, and subsequent runs will succeed.

## Failure handling

There's no type-checking for uploaded code, so failures are reported instead of crashing
anything:
- A syntax error is caught at registration time (upload fails with a reason).
- A missing/malformed `__synapseModule` (no `id`, no `run`, bad `needs`) shows as **invalid** in
  the popup with a reason.
- A `run()` that throws is caught and reported — it never crashes the extension.
