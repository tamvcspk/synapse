# Synapse

**A userscript platform for the browser — Tampermonkey's shape, with a real permission model and real
capabilities behind it.** Manifest V3 extension, TypeScript, no backend.

You write a `.js` file. It declares what it needs; the user grants it; the platform hands it an API
that can do things a plain userscript cannot — capture an HLS stream, mock a request, use an API key
it is never allowed to read.

```js
__synapseModule = {
  id: 'my-script',
  scopes: [
    'page.dom',
    { scope: 'net.request', match: ['https://api.example.com/*'] },
  ],
  async run(input, ctx) {
    const title = document.querySelector('h1')?.textContent ?? '';
    const res = await ctx.api.net.request({ url: `https://api.example.com/log?t=${title}` });
    ctx.api.ui.toast({ id: 'done', text: `Logged (${res.status})` });
  },
};
```

Write it in the built-in Monaco editor, run it against the current tab without saving, and see which
step failed — see [docs/user-scripts.md](docs/user-scripts.md) to actually get started.

## What it can do today

| | |
|---|---|
| **Scripts** | upload or author in-extension, rename/download/delete, edit with autocomplete from generated types, multi-step pipelines with per-step bypass, dry-run on the current tab |
| **Permissions** | per-script scopes with a resource dimension (`action × domain`), namespaced storage, grants bound to a source hash, consent UI that separates real gates from disclosures |
| **Capabilities** | cross-origin `fetch`, file save, request mocking, page `eval`, in-page UI (toast/badge/icon) with per-script quota, bundled libraries (Readability, Turndown, ZIP, HLS parser), reference-only secrets, thin LLM helper |
| **Media** | detect video/audio/streams a page requests, download and remux HLS (including AES-128 and live capture), resume after a crash |
| **Reference modules** | reader-mode converter, network sniffer, HTTP mocker — shipped read-only as working examples, each clonable into an editable template |

## Architecture in one paragraph

A minimal, `chrome.*`-free **Kernel** (`src/kernel/`) resolves a Module's declarations and injects
only the Services it asked for. Everything platform-specific lives under one **Adapter**
(`src/adapters/browser-extension/`), sliced by **feature** rather than by layer. The public contract
is `synapseApi` — one interface reachable over three transports (in-process, content-script RPC,
and the uploaded-script shim), with `module-registry/rpc-handler.ts` as the single, fail-closed
enforcement point.

> **There is no second runtime adapter, and there will not be one.** VS Code / Electron / Node were
> audited and rejected: ~0% of the feature surface could port, because every capability is a browser
> capability. Hexagonal structure is kept for **testability and dependency discipline** — `kernel/`
> and `shared/` stay provably free of `chrome.*`, which is checkable on every commit — never as a
> portability promise. See [docs/design.md](docs/design.md) §8.

## Documentation map

Start with the one that matches your question.

| You want | Read |
|---|---|
| To write a user script | [docs/user-scripts.md](docs/user-scripts.md) · [docs/api-inventory.md](docs/api-inventory.md) |
| To find code | [docs/INDEX.md](docs/INDEX.md) (generated) |
| What a term means | [docs/GLOSSARY.md](docs/GLOSSARY.md) |
| Architecture and settled decisions | [docs/design.md](docs/design.md) |
| What shipped, and which bugs were fixed | [docs/CHANGELOG.md](docs/CHANGELOG.md) |
| Browser/MV3 gotchas already paid for | [docs/LESSONS.md](docs/LESSONS.md) |
| What's next, and what's blocked | [docs/ROADMAP.md](docs/ROADMAP.md) |
| What still needs testing in a real browser | [docs/TEST_PLAN.md](docs/TEST_PLAN.md) |
| Rules for contributing (incl. AI agents) | [CLAUDE.md](CLAUDE.md) |

A feature's own business rules live beside its code, in `features/<name>/.domain.md`.

---

## ⚠️ Disclaimer

**Do not use Synapse in production or for illegal/unauthorized activities.**

- **Experimental software.** A personal playground: breaking changes, unfinished features, minimal
  stability guarantees. Much of it has not been verified in a real browser — see
  [docs/TEST_PLAN.md](docs/TEST_PLAN.md).
- **Not production-ready.** Not tested at scale, not hardened, not designed for multi-user or cloud
  deployment. Secrets are stored in plaintext at rest, deliberately and openly — read
  `features/secrets/.domain.md` before putting a real credential in it.
- **Prohibited uses:** unauthorized automation that violates a service's terms; credential theft,
  phishing, or social engineering; scraping protected data or circumventing access controls;
  interfering with computer systems or networks; impersonation or harassment; anything unlawful
  where you live.

**You are responsible for all use of this software.**

---

## Setup

**Requires** Node.js 18+, npm 9+, and a Chromium-based browser.

```bash
npm install
npm run dev          # Vite dev server, output in dist/browser-extension/
```

Then load it: `chrome://extensions/` → enable **Developer mode** → **Load unpacked** →
select `dist/browser-extension/`.

**One required manual step:** open the extension's entry in `chrome://extensions/` and enable
**"Allow user scripts"**. Without it `chrome.userScripts` is `undefined` and uploads fail. Chrome
does not reliably restart the service worker when you flip it — if uploads still fail, use the
**Reload extension** button in the error message, or restart the browser.

### Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server with hot reload |
| `npm run build` | Production build → `dist/browser-extension/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest, once |
| `npm test -- -u` | Same, updating generated snapshots (`docs/INDEX.md`, `docs/types/`, …) |
| `npm run test:watch` | Vitest in watch mode |

Committing a change that adds or renames a source directory? Run `npm test -- -u` — `docs/INDEX.md`
is generated and its snapshot test will otherwise fail.

### Project structure

```
src/
  kernel/                              # Core: Module contract, Services, Scheduler, scope catalog
  shared/                              # Pure functions only — must survive a MAIN-world import
  adapters/browser-extension/          # the only Adapter
    background/                        # service-worker composition root
    content-scripts/                   # content-script composition root + RPC client
    features/<name>/                   # one folder per capability (+ its .domain.md)
    module-registry/                   # discovery, uploads, the shim, permission enforcement
    ui/                                # popup, dashboard, studio, side panel, help, review, offscreen
    utils/                             # mechanism shared by 2+ features
docs/                                  # see the documentation map above
```

Filenames carry the execution context — `*.background.ts`, `*.content.ts`, `*.page.ts` (MAIN world),
`*.offscreen.ts`. That suffix is also what auto-discovery matches, so it is load-bearing.
Full map with file counts: [docs/INDEX.md](docs/INDEX.md).

---

## Troubleshooting

**Extension won't load** — confirm `dist/browser-extension/manifest.json` exists; reload it in
`chrome://extensions/`; check the service worker console (Details → Inspect views).

**Uploading a script fails** — "Allow user scripts" is almost always the cause; see Setup.

**A script's API calls are rejected** — the error names the reason. Common: the scope was never
granted, or it was granted for a different domain than the one being called. Grants also reset when
a script's source changes outside the Studio editor.

**A script runs but nothing happens** — the three silent-failure classes are documented in
[docs/user-scripts.md](docs/user-scripts.md): a function passed across the RPC boundary arrives as
`undefined`, `<style>`/`style=""` gets dropped by the page's CSP, and changes only take effect on
the page's next load, not immediately.

**Something in the extension "just doesn't work"** — check [docs/LESSONS.md](docs/LESSONS.md) before
debugging from scratch; most MV3 silent failures here have already been paid for once.

## License

Provided as-is for personal use. Respect the Disclaimer and all applicable laws.
