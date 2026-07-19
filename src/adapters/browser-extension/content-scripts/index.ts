import { registerDomModule } from './relay';
import { BUNDLED_MODULES } from '../module-registry/bundled-modules';
import { isModuleActive } from '../module-registry/storage';

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
      await mod.run(undefined, { services: {} });
    } catch (err) {
      console.error(`Synapse: module "${mod.id}" failed on auto-run`, err);
    }
  })();
}
