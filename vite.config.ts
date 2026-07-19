import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    // Scoped so a future adapter (e.g. vscode/electron) can build into its own dist/<env>/
    // without colliding with this one.
    outDir: 'dist/browser-extension',
  },
});
