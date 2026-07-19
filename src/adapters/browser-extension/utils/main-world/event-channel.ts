/**
 * Generic MAIN-world CustomEvent channel (Environment SDK — see the sdk-layers skill's
 * mechanism-vs-policy rule). Zero domain knowledge: works for any payload type `T`, carries no
 * assumptions about what's being synced. Safe to import from both the ISOLATED-world side
 * (storage-relay.ts, which dispatches) and a MAIN-world payload (which listens) — plain DOM
 * `CustomEvent` only, no chrome.* calls, no shared JS heap required between the two worlds.
 */
export interface MainWorldChannel<T> {
  dispatch(payload: T): void;
  onUpdate(handler: (payload: T) => void): void;
}

export function createMainWorldChannel<T>(channelId: string): MainWorldChannel<T> {
  return {
    dispatch(payload) {
      window.dispatchEvent(new CustomEvent<T>(channelId, { detail: payload }));
    },
    onUpdate(handler) {
      window.addEventListener(channelId, (event) => {
        handler((event as CustomEvent<T>).detail);
      });
    },
  };
}
