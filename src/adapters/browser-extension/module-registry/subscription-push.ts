import { SUBSCRIPTION_EVENT_MESSAGE_TYPE } from '../../../shared/subscription-bridge';

/**
 * Background → tab half of the subscription-push spike (docs/api-inventory.md §6 item 8). Same
 * shape as `network-sniffer.background.ts`'s `notifyTabMediaFound`: fire-and-forget
 * `chrome.tabs.sendMessage`, swallowing the "no receiver" rejection a tab with no content script (a
 * `chrome://` page, one that loaded before the extension did) produces — a missed push is a stale
 * `job()` poll away from being caught anyway, never a hang.
 *
 * Lands in `content-scripts/index.ts`'s own `onMessage` listener, which re-dispatches it as a DOM
 * `CustomEvent` so it can reach the USER_SCRIPT world too — see that file and
 * `module-registry/user-script-shim.ts` for the rest of the hop.
 */
export function pushSubscriptionEvent(tabId: number, topic: string, data: unknown): void {
  chrome.tabs.sendMessage(tabId, { type: SUBSCRIPTION_EVENT_MESSAGE_TYPE, topic, data }).catch(() => {});
}
