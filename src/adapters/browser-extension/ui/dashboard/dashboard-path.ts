/** Path must match the entry key vite.config.ts registers for `ui/dashboard/index.html` — shared
 * by ui/popup/main.ts (chrome.tabs.create) and content-scripts/index.ts (plain <a href>, docs/
 * ROADMAP.md #4.2's float-widget "View" action) so both build the same URL from one source. */
export const DASHBOARD_PATH = 'src/adapters/browser-extension/ui/dashboard/index.html';
