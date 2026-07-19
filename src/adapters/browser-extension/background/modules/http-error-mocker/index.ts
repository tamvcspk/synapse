import type { Module } from '../../../../../kernel/module';
import type { CollectionCommand } from '../../../../../kernel/ui-schema';
import { HTTP_METHODS, hasActiveMockConfig, validateMockConfig, type MockConfig } from '../../../../../shared/http-mock';
import { isModuleActive } from '../../../module-registry/storage';
import {
  isMainWorldScriptRegistered,
  registerMainWorldScript,
  unregisterMainWorldScript,
} from '../../../utils/main-world-injector';
import payloadPath from './main-world-payload?script&module';
import { MAIN_WORLD_SCRIPT_ID } from './constants';
import { getMockConfigs, setMockConfigs } from './mock-config-store';

/**
 * Background Module (docs/design.md §3.B, "browser-specific non-dom Modules" — see
 * main-world-interceptor skill for why this lives under background/modules/, not src/modules/).
 * Sole business authority for MockConfig: validates, persists, and decides whether the MAIN-world
 * interceptor should be registered. Delivered via the real Bus (needs: ['bus']) — see
 * background/index.ts for the wiring and the startup 'sync' emit.
 */
export const HttpErrorMockerModule: Module<CollectionCommand<MockConfig> | undefined, void> = {
  id: 'http-error-mocker',
  needs: ['bus'],
  uiSchema: {
    kind: 'collection',
    itemLabel: 'mock rule',
    idField: 'id',
    activeField: 'active',
    fields: [
      { key: 'endpointPattern', label: 'Endpoint pattern', type: 'string', required: true },
      { key: 'method', label: 'Method', type: 'enum', options: HTTP_METHODS, required: true },
      { key: 'fakeStatus', label: 'Fake status', type: 'number', required: true },
      { key: 'fakeResponse', label: 'Fake response', type: 'string', multiline: true },
      { key: 'delayMs', label: 'Delay (ms)', type: 'number' },
    ],
  },
  // Read-side counterpart to the CollectionCommand write path below — lets the Dashboard's generic
  // Management View (docs/ROADMAP.md #2.5) read this Module's data without importing
  // mock-config-store.ts directly (see kernel/module.ts's listCollection doc comment).
  listCollection: async () => (await getMockConfigs()) as unknown as Record<string, unknown>[],
  async run(command) {
    // Module-level Slide Toggle gate — mirrors relay.ts's dom-module active check. Inactive means
    // both "ignore CRUD commands" and "tear down the interceptor", not just a cosmetic toggle.
    if (!(await isModuleActive('http-error-mocker'))) {
      if (await isMainWorldScriptRegistered(MAIN_WORLD_SCRIPT_ID)) {
        await unregisterMainWorldScript(MAIN_WORLD_SCRIPT_ID);
      }
      return;
    }

    if (command?.op === 'upsert') {
      const result = validateMockConfig(command.item);
      if (!result.valid) throw new Error(`Invalid MockConfig: ${result.reason}`);
      const configs = await getMockConfigs();
      const index = configs.findIndex((c) => c.id === result.config.id);
      if (index === -1) configs.push(result.config);
      else configs[index] = result.config;
      await setMockConfigs(configs);
    } else if (command?.op === 'delete') {
      const configs = await getMockConfigs();
      await setMockConfigs(configs.filter((c) => c.id !== command.id));
    }

    await syncRegistration();
  },
};

async function syncRegistration(): Promise<void> {
  const [configs, registered] = await Promise.all([getMockConfigs(), isMainWorldScriptRegistered(MAIN_WORLD_SCRIPT_ID)]);
  const shouldBeRegistered = hasActiveMockConfig(configs);

  if (shouldBeRegistered && !registered) {
    await registerMainWorldScript({
      id: MAIN_WORLD_SCRIPT_ID,
      matches: ['<all_urls>'],
      jsPath: payloadPath,
      runAt: 'document_start',
    });
  } else if (!shouldBeRegistered && registered) {
    await unregisterMainWorldScript(MAIN_WORLD_SCRIPT_ID);
  }
}
