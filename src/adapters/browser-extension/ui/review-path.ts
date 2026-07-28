/** The Review page (docs/ROADMAP.md #3) — a standalone Tab for an Action-schema module's
 * `resultView: 'files'` result, or (docs/ROADMAP.md §9.1) the Side Panel's "Open in new tab".
 * Path must match the entry key vite.config.ts registers for `ui/review/index.html`. Shared here
 * (mirroring `dashboard-path.ts`/`side-panel-path.ts`) since both the popup and the Side Panel
 * need to build the same URL. */
export const REVIEW_PATH = 'src/adapters/browser-extension/ui/review/index.html';
