/** Path must match the entry key vite.config.ts registers for `ui/studio/index.html` — shared by
 * ui/popup/main.ts (chrome.tabs.create), same "extra Vite HTML entry" convention as
 * dashboard-path.ts/review-path.ts. `?moduleId=<id>` opens that uploaded script for editing;
 * omitted opens "New script" (docs/ROADMAP.md §12.2). */
export const STUDIO_PATH = 'src/adapters/browser-extension/ui/studio/index.html';
