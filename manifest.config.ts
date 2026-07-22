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
    },
  ],
  action: {
    default_popup: 'src/adapters/browser-extension/ui/popup/index.html',
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
  permissions: ['storage', 'userScripts', 'scripting', 'debugger', 'declarativeNetRequest'],
  // chrome.scripting.registerContentScripts (used for the MAIN-world interceptor) needs its own
  // host permission grant — a static content_scripts.matches entry doesn't satisfy it, even though
  // both show the same install-time warning. Without this, registerContentScripts resolves with no
  // error but silently never actually injects anything.
  host_permissions: ['<all_urls>'],
  // 'assets/*' covers http-error-mocker/mock-files.ts's build-time-enumerated files (docs/ROADMAP.md
  // #2.6) once they're big enough that Vite emits them as a real file instead of inlining as a
  // data: URL (build.assetsInlineLimit, ~4KB) — those need a real chrome-extension://<id>/... URL to
  // be usable as a rewriteUrl redirect target from an arbitrary page, which requires being declared
  // web-accessible. crxjs auto-adds its own entries here too (JS chunks it tracks as cross-context
  // dependencies) — this one is added manually since asset files aren't part of that tracking.
  // Scoped to 'assets/*' rather than per-file because Vite content-hashes filenames on every build.
  web_accessible_resources: [{ resources: ['assets/*'], matches: ['<all_urls>'] }],
});
