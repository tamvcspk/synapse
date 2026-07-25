/**
 * Shared string constants for network-sniffer's MAIN-world observer (docs/ROADMAP.md #4.1) — kept
 * in their own file so content-scripts/index.ts and dom-media-observer.ts (the ISOLATED-world
 * listeners) can import just these, without pulling index.ts's chrome.scripting-dependent
 * registration logic into the content-script bundle. Same pattern as http-error-mocker's
 * constants.ts.
 */
export const MAIN_WORLD_SCRIPT_ID = 'synapse-network-sniffer-observer';
/** MAIN world dispatches, ISOLATED world listens — the reverse direction of http-error-mocker's
 * MOCK_CONFIG_CHANNEL_ID, same underlying createMainWorldChannel primitive (it's symmetric). */
export const MAIN_WORLD_REPORT_CHANNEL_ID = 'synapse:network-sniffer:main-world-report';
/** docs/ROADMAP.md #7.3(a) — MAIN world dispatches `{blobUrl, url}` pairs learned from
 * media-source-interceptor.ts's hook, ISOLATED world (dom-media-observer.ts) uses them to anchor a
 * download badge to the SPECIFIC `<video>`/`<audio>` whose `blob:` src matches, instead of the old
 * single-page-global "last observed URL" heuristic. */
export const MAIN_WORLD_CORRELATION_CHANNEL_ID = 'synapse:network-sniffer:main-world-correlation';
/** docs/ROADMAP.md #7.3(a-hls) — set directly on a `<video>` element by hls-global-hook.ts's
 * `MANIFEST_LOADED` handler, not relayed through a message channel: the DOM itself is shared
 * between the MAIN and ISOLATED worlds (only the JS object heap is separate), so a plain attribute
 * write is visible to dom-media-observer.ts immediately. An EXACT pairing (no correlation-window
 * guessing) when present — checked before the blobUrl-map/`'play'`-event fallbacks. */
export const HLS_CORRELATION_ATTRIBUTE = 'data-synapse-hls-url';
