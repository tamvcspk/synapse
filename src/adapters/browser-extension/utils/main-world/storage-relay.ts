import { createMainWorldChannel } from './event-channel';

/**
 * Generic ISOLATED-world relay (Environment SDK): forwards a chrome.storage.local key's value into
 * a MAIN-world event channel, both on install and on every future change. Runs in the content-script
 * (ISOLATED) world, which has chrome.storage + window access, unlike the MAIN-world payload it feeds.
 * Generic over `T` and over which storage key/channel it relays — no domain knowledge of what's
 * stored. Call once per (storageKey, channelId) pair that needs this bridge.
 */
export function installStorageToMainWorldRelay<T>(storageKey: string, channelId: string): void {
  const channel = createMainWorldChannel<T>(channelId);

  void chrome.storage.local.get(storageKey).then((stored) => {
    channel.dispatch(stored[storageKey] as T);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !(storageKey in changes)) return;
    channel.dispatch(changes[storageKey]?.newValue as T);
  });
}
