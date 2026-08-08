/**
 * docs/ROADMAP.md Track A — the two triggers behind the platform's non-permanent state lifetimes
 * (§A1's **navigation** lifetime, §A2's **tab** lifetime). Despite living under `features/media/`
 * (where the first, and so far only, **navigation**-scoped consumer — the detected-media list —
 * lives), this file is NOT media-specific: `chrome.webNavigation.onCommitted`/`chrome.tabs.onRemoved`
 * are platform-level triggers, so it also drives `synapseApi.storage.session`/`.tab`'s eviction
 * (`module-registry/script-storage.ts`) across every script, not just this feature's own state.
 * Features already import platform helpers the other direction (e.g. `isModuleActive` from
 * `module-registry/storage.ts`), so this file importing FROM `module-registry/` is the same,
 * already-established direction, not a new layering exception.
 *
 * No Module wraps any of this — there is no user-facing on/off toggle for "does state get evicted
 * on navigation/tab-close", and none of it has a `run()` shape to gate behind one; both listeners
 * install unconditionally at service-worker startup, same "always installed, cheap no-op when
 * irrelevant" posture as webrequest-media-observer.background.ts's own listener.
 */

import { clearSessionScopedStorageForTab, clearTabScopedStorageForTab } from '../../module-registry/script-storage';
import { clearDetectedMediaForTab } from './store';

/**
 * `chrome.tabs.onUpdated`'s `changeInfo.url` (used elsewhere for other purposes, e.g.
 * `background/index.ts`'s Side Panel sync) never fires on a reload of the SAME url, so it cannot
 * see the case this exists for: reload a page, and **navigation**-scoped state (the media list,
 * `storage.session`) must reset even though the url never changed. `chrome.webNavigation.onCommitted`
 * fires on every top-level navigation commit, reload included, which is exactly the signal needed.
 *
 * Filtered to `frameId === 0` (the tab's own top-level frame) — a sub-frame/iframe navigating (an ad
 * slot refreshing, an embedded player re-initializing) is not the user navigating away from the page,
 * and must not wipe state for the page they're still looking at. `storage.tab` is deliberately NOT
 * touched here — surviving navigation within the same tab is the entire point of the tab lifetime.
 */
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  void clearDetectedMediaForTab(details.tabId);
  void clearSessionScopedStorageForTab(details.tabId);
});

/**
 * The **tab** lifetime's own trigger — `storage.tab` dies when the tab closes. A closed tab also
 * ends whatever navigation/page-load it was showing, so its `storage.session` keys are swept here
 * too (the alternative — leaving them for the NEXT `onCommitted` on a tabId Chrome may never reuse —
 * would just leak them forever). The detected-media list is deliberately NOT swept here: its own
 * `MAX_DETECTED_ITEMS` cap already bounds growth, and Track A1 never asked for tab-close eviction on
 * top of navigation eviction.
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  void clearTabScopedStorageForTab(tabId);
  void clearSessionScopedStorageForTab(tabId);
});
