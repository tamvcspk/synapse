import {
  ACTIVATION_STORAGE_KEY,
  UI_MUTED_STORAGE_KEY,
  getActivationMap,
  getUiMutedMap,
} from './storage';

/**
 * Pushes activation/mute changes to already-open pages (docs/ROADMAP.md §11.4).
 *
 * Core owns the surface lifecycle, which means switching a Module off — or muting just its UI — has
 * to remove what is on screen NOW. Reading the flag once at injection time only covers the next page
 * load, which is exactly the kind of half-working lifecycle the compositor is supposed to end.
 *
 * Both flags land in the same `chrome.storage.local` change event and answer the same question, so
 * they are collapsed into one signal here rather than two listeners that each know half the answer.
 */

/** Ids whose boolean value differs between two stored maps, treating "absent" as `fallback`. */
function changedIds(oldValue: unknown, newValue: unknown, fallback: boolean): string[] {
  const before = (oldValue ?? {}) as Record<string, boolean>;
  const after = (newValue ?? {}) as Record<string, boolean>;
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...ids].filter((id) => (before[id] ?? fallback) !== (after[id] ?? fallback));
}

/**
 * Calls `handler(moduleId, visible)` for every Module whose *effective* UI visibility changed.
 * `visible` is `active && !muted`, so a caller never has to combine the two itself.
 */
export function onUiVisibilityChanged(handler: (moduleId: string, visible: boolean) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    const ids = new Set<string>();
    // Activation defaults to true when absent, mute to false — passing the wrong default here would
    // report a spurious change for every id the first time either map is written.
    const activation = changes[ACTIVATION_STORAGE_KEY];
    if (activation) for (const id of changedIds(activation.oldValue, activation.newValue, true)) ids.add(id);
    const muted = changes[UI_MUTED_STORAGE_KEY];
    if (muted) for (const id of changedIds(muted.oldValue, muted.newValue, false)) ids.add(id);
    if (ids.size === 0) return;

    void (async () => {
      const [activationMap, mutedMap] = await Promise.all([getActivationMap(), getUiMutedMap()]);
      for (const id of ids) {
        handler(id, (activationMap[id] ?? true) && !(mutedMap[id] ?? false));
      }
    })();
  });
}
