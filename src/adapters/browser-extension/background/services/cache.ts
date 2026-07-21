import type { CacheService } from '../../../../kernel/module';

/**
 * chrome.storage.local-backed CacheService (kernel-bootstrap skill's reference implementation) —
 * the one Adapter-level storage primitive every capability-declaring Module (background, dom via
 * the RPC bridge, or uploaded) shares instead of touching chrome.storage.local directly.
 */
export const chromeStorageCache: CacheService = {
  async get(key) {
    const result = await chrome.storage.local.get(key);
    return result[key];
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
};
