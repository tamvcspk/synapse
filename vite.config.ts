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
        // Offscreen Document (docs/ROADMAP.md §8.1) — hosts the HLS download engine
        // (utils/download-engine.ts). Same "extra Vite HTML entry" treatment as the others: an
        // offscreen document has no manifest field of its own either (unlike `side_panel`), it's
        // created purely at runtime via chrome.offscreen.createDocument (utils/offscreen-manager.ts).
        offscreen: 'src/adapters/browser-extension/ui/offscreen/index.html',
        // §12.2 Monaco spike (docs/ROADMAP.md) — NOT the real Studio page yet, see studio/main.ts's
        // doc comment. Same "extra Vite HTML entry" treatment as the others above.
        studio: 'src/adapters/browser-extension/ui/studio/index.html',
        // Help page (docs/ROADMAP.md §11.6 item 9) — same "extra Vite HTML entry" treatment as the
        // others above, opened the same way (chrome.tabs.create from the popup).
        help: 'src/adapters/browser-extension/ui/help/index.html',
      },
    },
  },
});
