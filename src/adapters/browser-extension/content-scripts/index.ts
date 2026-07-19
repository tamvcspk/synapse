import { registerDomModule } from './relay';
import { buildDomModuleServices } from './rpc-client';
import { BUNDLED_MODULES } from '../module-registry/bundled-modules';
import { isModuleActive } from '../module-registry/storage';
import { installStorageToMainWorldRelay } from '../utils/main-world/storage-relay';
import { MOCK_CONFIG_CHANNEL_ID, MOCK_CONFIG_STORAGE_KEY } from '../background/modules/http-error-mocker/constants';

// Generic infra call (not a Module — see main-world-interceptor skill): forwards
// http-error-mocker's persisted MockConfig list into its MAIN-world interceptor whenever it's
// registered. Kept explicit rather than auto-discovered — only one feature needs this today.
installStorageToMainWorldRelay(MOCK_CONFIG_STORAGE_KEY, MOCK_CONFIG_CHANNEL_ID);

const domModules = BUNDLED_MODULES.filter((mod) => mod.needs?.includes('dom'));

for (const mod of domModules) {
  registerDomModule(mod);
}

// One-off smoke-test invocation per active 'dom' Module, so loading the extension gives
// immediate visual confirmation that the Kernel foundation + auto-discovery wire up correctly.
for (const mod of domModules) {
  void (async () => {
    if (!(await isModuleActive(mod.id))) return;
    try {
      await mod.run(undefined, { services: buildDomModuleServices(mod.id, mod.needs) });
    } catch (err) {
      console.error(`Synapse: module "${mod.id}" failed on auto-run`, err);
    }
  })();
}
