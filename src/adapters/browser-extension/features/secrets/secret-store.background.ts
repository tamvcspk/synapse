import type { CacheService } from '../../../../kernel/module';
import type { SecretRecord } from '../../../../shared/secrets';
import { chromeStorageCache } from '../../background/services/cache';
import { SECRETS_STORAGE_KEY } from './constants';

/**
 * CacheService-backed CRUD for SecretRecord — same DI shape as
 * features/http-mock/mock-config-store.background.ts's `getMockConfigs`/`setMockConfigs`. `cache`
 * defaults to the real chrome.storage.local-backed singleton so callers with no injected
 * `ctx.services.cache` (e.g. `listCollection()`, `net-request-host.ts`) still work against the real
 * store, while a unit test can pass a fake one.
 */
export async function getSecrets(cache: CacheService = chromeStorageCache): Promise<SecretRecord[]> {
  const stored = await cache.get(SECRETS_STORAGE_KEY);
  return (stored as SecretRecord[] | undefined) ?? [];
}

export async function setSecrets(secrets: SecretRecord[], cache: CacheService = chromeStorageCache): Promise<void> {
  await cache.set(SECRETS_STORAGE_KEY, secrets);
}

/** Looked up by name, never by id — a script only ever knows the `secretRef` name it declared, and
 * neither runtime caller (`net-request-host.ts`, `ai-ask-host.ts` — both via `secret-resolution.ts`)
 * has anything else to look it up by. */
export async function findSecretByName(name: string, cache: CacheService = chromeStorageCache): Promise<SecretRecord | undefined> {
  const secrets = await getSecrets(cache);
  return secrets.find((s) => s.name === name);
}
