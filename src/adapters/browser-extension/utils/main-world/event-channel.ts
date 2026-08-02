/**
 * Generic MAIN-world CustomEvent channel (Environment SDK — see the sdk-layers skill's
 * mechanism-vs-policy rule). Zero domain knowledge: works for any payload type `T`, carries no
 * assumptions about what's being synced. Safe to import from both the ISOLATED-world side
 * (storage-relay.ts, which dispatches) and a MAIN-world payload (which listens) — plain DOM
 * `CustomEvent` only, no chrome.* calls, no shared JS heap required between the two worlds.
 */
export interface MainWorldChannel<T> {
  dispatch(payload: T): void;
  /** Returns an unsubscribe function — added for the subscription-push spike
   * (docs/api-inventory.md §6 item 8, `module-registry/rpc-client.ts`'s `media.onProgress`), whose
   * callers register and tear down a listener per subscribe call. Every existing caller ignores the
   * return value, so this is additive, not a breaking change. */
  onUpdate(handler: (payload: T) => void): () => void;
}

export function createMainWorldChannel<T>(channelId: string): MainWorldChannel<T> {
  return {
    dispatch(payload) {
      window.dispatchEvent(new CustomEvent<T>(channelId, { detail: payload }));
    },
    onUpdate(handler) {
      const listener = (event: Event): void => {
        handler((event as CustomEvent<T>).detail);
      };
      window.addEventListener(channelId, listener);
      return () => window.removeEventListener(channelId, listener);
    },
  };
}
