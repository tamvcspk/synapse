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
