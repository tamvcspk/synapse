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
 * handler. An EXACT pairing (no correlation-window guessing) when present — checked before the
 * blobUrl-map/`'play'`-event fallbacks. The DOM itself is shared between the MAIN and ISOLATED
 * worlds, so the attribute value is readable by dom-media-observer.ts as soon as it's set — but
 * being READABLE doesn't mean a rescan gets TRIGGERED: dom-media-observer.ts's MutationObserver is
 * scoped to `attributeFilter: ['src']`, so writing this attribute alone never fires it (a real bug,
 * found via live testing — the badge only appeared when some unrelated `src` mutation happened to
 * trigger a rescan around the same time, i.e. intermittently). `MAIN_WORLD_HLS_CORRELATION_CHANNEL_ID`
 * below is the fix — an explicit "rescan now" signal dispatched right after this attribute is set. */
export const HLS_CORRELATION_ATTRIBUTE = 'data-synapse-hls-url';
/** docs/ROADMAP.md §7.3(a-hls) bugfix — see HLS_CORRELATION_ATTRIBUTE's doc comment above for why
 * this is needed: the attribute write alone doesn't trigger dom-media-observer.ts's rescan. Empty
 * payload — the ISOLATED-world listener just re-reads the attribute fresh off the DOM on its own,
 * this channel exists purely as a "look again now" trigger, same role
 * MAIN_WORLD_CORRELATION_CHANNEL_ID's dispatch already plays for the blobUrl-map signal. */
export const MAIN_WORLD_HLS_CORRELATION_CHANNEL_ID = 'synapse:network-sniffer:main-world-hls-correlation';
