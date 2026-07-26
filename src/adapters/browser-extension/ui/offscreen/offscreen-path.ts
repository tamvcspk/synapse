/** Path must match the entry key vite.config.ts registers for `ui/offscreen/index.html` — shared by
 * utils/offscreen-manager.ts (the only caller of chrome.offscreen.createDocument, docs/ROADMAP.md
 * §8.1). Unlike DASHBOARD_PATH/SIDE_PANEL_PATH this is never turned into a `chrome.tabs.create`/
 * `chrome.sidePanel` URL — an offscreen document has no manifest field of its own and is never
 * user-visible. */
export const OFFSCREEN_PATH = 'src/adapters/browser-extension/ui/offscreen/index.html';
