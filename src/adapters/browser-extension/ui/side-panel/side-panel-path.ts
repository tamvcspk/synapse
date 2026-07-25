/** Path must match the entry key crx auto-registers from manifest.config.ts's `side_panel.
 * default_path` — shared so background/index.ts can pass an explicit `path` to
 * `chrome.sidePanel.setOptions`/`.open` instead of relying on the tab ever having inherited the
 * manifest-level default on its own (docs/ROADMAP.md §6.6). */
export const SIDE_PANEL_PATH = 'src/adapters/browser-extension/ui/side-panel/index.html';
