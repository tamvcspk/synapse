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
  permissions: ['storage', 'userScripts', 'scripting'],
  // chrome.scripting.registerContentScripts (used for the MAIN-world interceptor) needs its own
  // host permission grant — a static content_scripts.matches entry doesn't satisfy it, even though
  // both show the same install-time warning. Without this, registerContentScripts resolves with no
  // error but silently never actually injects anything.
  host_permissions: ['<all_urls>'],
});
