/**
 * Shared string constants for the http-error-mocker Module. Kept in their own file so
 * content-scripts/index.ts (the ISOLATED-world relay wiring) can import just these, without
 * pulling in index.ts's chrome.scripting-dependent registration logic into the content-script
 * bundle.
 */
export const MOCK_CONFIG_STORAGE_KEY = 'synapse:http-error-mocker:configs';
export const MOCK_CONFIG_CHANNEL_ID = 'synapse:http-error-mocker:config';
export const MAIN_WORLD_SCRIPT_ID = 'synapse-http-interceptor';
