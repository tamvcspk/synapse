import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    // Scoped so a future adapter (e.g. vscode/electron) can build into its own dist/<env>/
    // without colliding with this one.
    outDir: 'dist/browser-extension',
    rollupOptions: {
      input: {
        // The Dashboard page (docs/ROADMAP.md #2.5) isn't the popup/options/devtools/sandbox — no
        // manifest field crx's htmlFiles() scan recognizes fits a plain chrome.tabs.create-opened
        // page, so it's registered here as an ordinary extra Vite HTML entry instead. Key doesn't
        // matter for output path; Vite preserves the input path (matches how manifest.config.ts's
        // action.default_popup path is mirrored in dist).
        dashboard: 'src/adapters/browser-extension/ui/dashboard/index.html',
        // Review page (docs/ROADMAP.md #3) — same "extra Vite HTML entry" treatment as `dashboard`
        // above, opened the same way (chrome.tabs.create from the popup), no manifest field fits it.
        review: 'src/adapters/browser-extension/ui/review/index.html',
        // Merge page (docs/ROADMAP.md #5.3) — same treatment, opened via a `rowActions` 'open-tab'
        // action (kernel/ui-schema.ts) from the Dashboard's Management View instead of the popup.
        merge: 'src/adapters/browser-extension/ui/merge/index.html',
      },
    },
  },
});
