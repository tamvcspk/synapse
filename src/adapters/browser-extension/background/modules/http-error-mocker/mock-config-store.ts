import type { MockConfig } from '../../../../../shared/http-mock';
import { MOCK_CONFIG_STORAGE_KEY } from './constants';

/**
 * chrome.storage.local-backed CRUD for MockConfig — module-owned persistence. Only index.ts (the
 * Module) calls the write helpers; popup reads via getMockConfigs() for rendering but writes go
 * through the Bus (popup/module-data-sources.ts) so index.ts stays the sole validation authority.
 */
export async function getMockConfigs(): Promise<MockConfig[]> {
  const stored = await chrome.storage.local.get(MOCK_CONFIG_STORAGE_KEY);
  return (stored[MOCK_CONFIG_STORAGE_KEY] as MockConfig[] | undefined) ?? [];
}

export async function setMockConfigs(configs: MockConfig[]): Promise<void> {
  await chrome.storage.local.set({ [MOCK_CONFIG_STORAGE_KEY]: configs });
}
