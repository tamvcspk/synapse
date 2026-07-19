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
    },
  ],
  action: {
    default_popup: 'src/adapters/browser-extension/popup/index.html',
  },
  permissions: ['storage', 'userScripts', 'scripting'],
});
