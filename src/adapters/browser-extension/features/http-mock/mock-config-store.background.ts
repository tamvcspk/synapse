import type { CacheService } from '../../../../kernel/module';
import type { MockConfig } from '../../../../shared/http-mock';
import { chromeStorageCache } from '../../background/services/cache';
import { MOCK_CONFIG_STORAGE_KEY } from './constants';

/**
 * CacheService-backed CRUD for MockConfig — module-owned persistence, routed through the Kernel's
 * 'cache' capability (docs/design.md §3.A/§1's Port pattern) instead of chrome.storage.local
 * directly. index.ts's run() passes its injected ctx.services.cache through; listCollection() has
 * no ctx (see kernel/module.ts's doc comment on that method), so it defaults to the same
 * chromeStorageCache singleton the ServiceInjector itself resolves to — one storage implementation
 * either way, never a second ad-hoc chrome.storage.local accessor.
 */
export async function getMockConfigs(cache: CacheService = chromeStorageCache): Promise<MockConfig[]> {
  const stored = await cache.get(MOCK_CONFIG_STORAGE_KEY);
  return (stored as MockConfig[] | undefined) ?? [];
}

export async function setMockConfigs(configs: MockConfig[], cache: CacheService = chromeStorageCache): Promise<void> {
  await cache.set(MOCK_CONFIG_STORAGE_KEY, configs);
}
