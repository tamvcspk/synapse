/**
 * Shared shape for the subscription push spike (docs/api-inventory.md §4, §6 item 8). Generic on
 * purpose: `net.observe`, `media.download` progress, and `contextMenus` are named as three separate
 * problems in the doc, but they all reduce to the same one — getting a serializable event from the
 * background service worker into a caller's own world without a function ever crossing
 * `chrome.runtime.sendMessage`'s structured-clone boundary. `topic` is how a caller-local handler
 * (registered via `synapseApi.media.onProgress` etc., never sent anywhere) finds the push meant for
 * it; `data` is whatever that call's own payload shape is.
 *
 * Two constants, two different layers: `SUBSCRIPTION_EVENT_MESSAGE_TYPE` tags the
 * `chrome.tabs.sendMessage` background sends to a tab's content script (the same shape
 * `network-sniffer.background.ts`'s `synapse:media-found` uses); `SUBSCRIPTION_PUSH_CHANNEL_ID` is
 * the DOM `CustomEvent` name the content script re-dispatches on `window` to hop from its own
 * ISOLATED world into MAIN and USER_SCRIPT, which share the same `window` but not the same JS heap
 * (`utils/main-world/event-channel.ts`'s mechanism, reused here for a hop this codebase had never
 * made before: ISOLATED → USER_SCRIPT, not ISOLATED → MAIN. **Confirmed working on real Chrome** —
 * see `module-registry/user-script-shim.ts`'s doc comment).
 */
export const SUBSCRIPTION_EVENT_MESSAGE_TYPE = 'synapse:subscription-event';
export const SUBSCRIPTION_PUSH_CHANNEL_ID = 'synapse:subscription-push';

export interface SubscriptionPushPayload {
  topic: string;
  data: unknown;
}
