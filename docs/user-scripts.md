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
assigning one global; the platform hands you its API as `run()`'s second argument:

```javascript
globalThis.__synapseModule = {
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

**`ctx.api` is the only handle — there is no `synapseApi` global.** Every uploaded script shares one
execution world, so a global name has a single binding for all of them and cannot tell the platform
which script is calling: the last script loaded would own it, and everyone else's calls would run
under *its* identity and *its* permissions. To use the API outside `run()` (from an event handler,
say), capture it:

```javascript
let api;
globalThis.__synapseModule = {
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
