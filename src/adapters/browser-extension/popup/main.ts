import type { RegistryEntry } from '../../../kernel/module-registry';
import { ChromeModuleRegistryService } from '../module-registry/chrome-module-registry';
import { isUserScriptsPermissionGranted } from '../module-registry/storage';
import { confirmCapabilities } from './capability-dialog';
import { renderPopup } from './render';

const registry = new ChromeModuleRegistryService();
const root = document.getElementById('root')!;

const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = '.js';
fileInput.style.display = 'none';
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  await registry.uploadModule(await file.text());
  await load();
});
document.body.append(fileInput);

async function load(): Promise<void> {
  const [entries, userScriptsPermissionGranted] = await Promise.all([
    registry.list(),
    isUserScriptsPermissionGranted(),
  ]);
  renderPopup(
    root,
    entries,
    {
      onToggle: handleToggle,
      onGrant: handleGrant,
      onUpload: () => fileInput.click(),
      onRefresh: handleRefresh,
    },
    { userScriptsPermissionGranted },
  );
}

async function handleGrant(entry: RegistryEntry): Promise<void> {
  const ungranted = entry.needs.filter((n) => !entry.grantedCapabilities.includes(n));
  if (ungranted.length === 0) return;
  const approved = await confirmCapabilities(entry.label ?? entry.id, ungranted);
  if (!approved) return;
  await registry.grantCapabilities(entry.id, [...entry.grantedCapabilities, ...ungranted]);
  await load();
}

async function handleToggle(entry: RegistryEntry): Promise<void> {
  if (entry.active) {
    await registry.deactivate(entry.id);
  } else {
    if (entry.needs.length > 0) {
      const approved = await confirmCapabilities(entry.label ?? entry.id, entry.needs);
      if (!approved) return;
      await registry.grantCapabilities(entry.id, entry.needs);
    }
    await registry.activate(entry.id);
  }
  await load();
}

async function handleRefresh(): Promise<void> {
  await registry.refresh();
  await load();
}

void load();
