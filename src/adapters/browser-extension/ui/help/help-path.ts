/** Path must match the entry key vite.config.ts registers for `ui/help/index.html` — shared by
 * ui/popup/main.ts (chrome.tabs.create) so both build the same URL from one source, same convention
 * as `dashboard-path.ts`/`studio-path.ts`. */
export const HELP_PATH = 'src/adapters/browser-extension/ui/help/index.html';
