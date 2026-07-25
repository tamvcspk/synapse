import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

export default defineManifest({
  manifest_version: 3,
  name: 'Synapse',
  version: pkg.version,
  description: pkg.description,
  background: {
    service_worker: 'src/adapters/browser-extension/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/adapters/browser-extension/content-scripts/index.ts'],
      // Defaults to 'document_idle' — far later than the MAIN-world interceptor's own
      // 'document_start' registration (see main-world-injector.ts). That gap let a page's own
      // early requests (e.g. GitHub's hovercard/sponsor-button calls) race past with an empty
      // configs array before this ISOLATED-world relay ever read chrome.storage and dispatched
      // the CustomEvent into MAIN world. Matching runAt closes nearly all of that window.
      run_at: 'document_start',
      // all_frames intentionally NOT set here (defaults to false, top-frame-only) — see
      // frame-media-observer.ts's entry below for why this stays separate.
    },
    // Separate entry, `all_frames: true` (docs/ROADMAP.md #4) — network-sniffer's DOM/iframe
    // detection and iframe-unsandbox's fix both need to run inside every nested/cross-origin
    // iframe, not just the top frame. Kept as its OWN entry rather than flipping all_frames on the
    // entry above: chrome.tabs.sendMessage(tabId, msg) with no frameId broadcasts to every frame in
    // the tab, so putting content-scripts/index.ts's registerDomModule (reader-mode-converter's
    // Action-schema dispatch) in every iframe too would let multiple frames race to answer the same
    // trigger message — a real regression unrelated to this feature.
    {
      matches: ['<all_urls>'],
      js: ['src/adapters/browser-extension/content-scripts/frame-media-observer.ts'],
      all_frames: true,
      // 'document_start' (not the default 'document_idle') matters for iframe-unsandbox: widening a
      // sandboxed <iframe>'s token list only takes effect on that frame's *next* navigation, so the
      // parent frame's fix needs to land before a freshly-encountered sandboxed child begins its own
      // load. network-sniffer's DOM scan already waits for DOMContentLoaded internally regardless.
      run_at: 'document_start',
    },
  ],
  action: {
    default_popup: 'src/adapters/browser-extension/ui/popup/index.html',
  },
  // docs/ROADMAP.md §6.2 — network-sniffer's Side Panel, opened on demand via
  // chrome.sidePanel.open({tabId}) from a background relay (background/index.ts), triggered by
  // the on-page floating icon's click (utils/floating-widget.ts's showFloatingIcon).
  side_panel: {
    default_path: 'src/adapters/browser-extension/ui/side-panel/index.html',
  },
  // 'debugger' is required by http-error-mocker's 'debugger' mechanism (docs/ROADMAP.md #2.6) —
  // it attaches Chrome's remote debugging protocol (CDP) to tabs so mocked requests/responses
  // are real network-stack traffic (visible in DevTools' Network tab, catches non-fetch/XHR
  // requests like images/files), instead of the MAIN-world fetch/XHR patch's synthetic Response.
  // Chrome shows a persistent "Synapse is debugging this browser" banner on any tab it's attached
  // to — an unavoidable trade-off of this permission, not a bug.
  // 'declarativeNetRequest' is required by the 'dnr' mechanism (utils/dnr-network-rules.ts) — same
  // real-network-stack/Network-tab visibility as 'debugger', but native MV3 (no banner) and purely
  // declarative (Chrome's engine evaluates the rules, not our JS) — at the cost of never seeing a
  // request's body, so 'dnr' rules can't rewrite/match on it (see shared/http-mock.ts's Mechanism
  // doc comment).
  // 'webRequest' backs network-sniffer's chrome.webRequest.onBeforeRequest observer
  // (utils/webrequest-media-observer.ts, docs/ROADMAP.md #4) — read-only request observation, no
  // 'webRequestBlocking' (not needed here, and MV3 service workers can't register blocking
  // webRequest listeners anyway). Shows no banner, unlike 'debugger'.
  // 'downloads' backs the Management View's generic per-row `rowActions` 'download' kind
  // (kernel/ui-schema.ts), first used by network-sniffer's "Download" action on a detected media URL.
  // 'sidePanel' backs network-sniffer's Side Panel (docs/ROADMAP.md #6.2).
  permissions: ['storage', 'userScripts', 'scripting', 'debugger', 'declarativeNetRequest', 'webRequest', 'downloads', 'sidePanel'],
  // chrome.scripting.registerContentScripts (used for the MAIN-world interceptor) needs its own
  // host permission grant — a static content_scripts.matches entry doesn't satisfy it, even though
  // both show the same install-time warning. Without this, registerContentScripts resolves with no
  // error but silently never actually injects anything.
  host_permissions: ['<all_urls>'],
  // 'wasm-unsafe-eval' widens MV3's default extension_pages CSP (which blocks WebAssembly
  // compilation the same as it blocks eval()) — required by ffmpeg.wasm's WebAssembly.instantiate
  // on the Merge page (docs/ROADMAP.md #5.3, HLS segment download+remux). Scoped to
  // extension_pages only (the Merge tab), not sandbox or content scripts.
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
  // 'assets/*' covers http-error-mocker/mock-files.ts's build-time-enumerated files (docs/ROADMAP.md
  // #2.6) once they're big enough that Vite emits them as a real file instead of inlining as a
  // data: URL (build.assetsInlineLimit, ~4KB) — those need a real chrome-extension://<id>/... URL to
  // be usable as a rewriteUrl redirect target from an arbitrary page, which requires being declared
  // web-accessible. crxjs auto-adds its own entries here too (JS chunks it tracks as cross-context
  // dependencies) — this one is added manually since asset files aren't part of that tracking.
  // Scoped to 'assets/*' rather than per-file because Vite content-hashes filenames on every build.
  web_accessible_resources: [{ resources: ['assets/*'], matches: ['<all_urls>'] }],
});
