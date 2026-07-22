import type { Capability } from '../../../kernel/module';
import type { ManifestReport } from '../../../kernel/rpc';

const KEYS = {
  activation: 'synapse:activation',
  grants: 'synapse:grants',
  uploaded: 'synapse:uploaded',
  manifestReports: 'synapse:manifest-reports',
  userScriptsPermission: 'synapse:user-scripts-permission',
  subState: 'synapse:sub-state',
} as const;

export type StoredManifestReport = Omit<ManifestReport, 'type'>;

async function getStored<T>(key: string, fallback: T): Promise<T> {
  const stored = await chrome.storage.local.get(key);
  return (stored[key] as T | undefined) ?? fallback;
}

async function setStored<T>(key: string, value: T): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function getActivationMap(): Promise<Record<string, boolean>> {
  return getStored(KEYS.activation, {});
}

/** Bundled modules default to active until explicitly toggled off; unknown ids default active too. */
export async function isModuleActive(id: string): Promise<boolean> {
  const map = await getActivationMap();
  return map[id] ?? true;
}

export async function setModuleActive(id: string, active: boolean): Promise<void> {
  const map = await getActivationMap();
  map[id] = active;
  await setStored(KEYS.activation, map);
}

export async function getGrantsMap(): Promise<Record<string, Capability[]>> {
  return getStored(KEYS.grants, {});
}

export async function setGrants(id: string, capabilities: Capability[]): Promise<void> {
  const map = await getGrantsMap();
  map[id] = capabilities;
  await setStored(KEYS.grants, map);
}

export async function getUploadedSources(): Promise<Record<string, string>> {
  return getStored(KEYS.uploaded, {});
}

export async function setUploadedSource(id: string, source: string): Promise<void> {
  const map = await getUploadedSources();
  map[id] = source;
  await setStored(KEYS.uploaded, map);
}

export async function deleteUploadedSource(id: string): Promise<void> {
  const map = await getUploadedSources();
  delete map[id];
  await setStored(KEYS.uploaded, map);
}

export async function getManifestReports(): Promise<Record<string, StoredManifestReport>> {
  return getStored(KEYS.manifestReports, {});
}

export async function setManifestReport(moduleId: string, report: StoredManifestReport): Promise<void> {
  const map = await getManifestReports();
  map[moduleId] = report;
  await setStored(KEYS.manifestReports, map);
}

export async function deleteManifestReport(moduleId: string): Promise<void> {
  const map = await getManifestReports();
  delete map[moduleId];
  await setStored(KEYS.manifestReports, map);
}

/** Per-Composite-Module sub-step bypass state (docs/ROADMAP.md #3), keyed by composite module id
 * then sub-module id. A sub-module missing from its composite's map defaults to active. */
export async function getSubStateMap(): Promise<Record<string, Record<string, boolean>>> {
  return getStored(KEYS.subState, {});
}

export async function setSubModuleActive(id: string, subId: string, active: boolean): Promise<void> {
  const map = await getSubStateMap();
  map[id] = { ...map[id], [subId]: active };
  await setStored(KEYS.subState, map);
}

/**
 * Whether chrome.userScripts.configureWorld({ messaging: true }) last succeeded — set once from
 * background/index.ts at startup. Defaults to true (assume ok) so the popup doesn't flash a
 * warning before the background has had a chance to report in.
 */
export async function isUserScriptsPermissionGranted(): Promise<boolean> {
  return getStored(KEYS.userScriptsPermission, true);
}

export async function setUserScriptsPermissionGranted(granted: boolean): Promise<void> {
  await setStored(KEYS.userScriptsPermission, granted);
}
