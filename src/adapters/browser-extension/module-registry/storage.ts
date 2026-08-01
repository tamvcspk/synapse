import type { ManifestReport } from '../../../kernel/rpc';
import type { SynapseScopeGrant } from '../../../kernel/synapse-api';

const KEYS = {
  activation: 'synapse:activation',
  grants: 'synapse:grants',
  uploaded: 'synapse:uploaded',
  manifestReports: 'synapse:manifest-reports',
  userScriptsPermission: 'synapse:user-scripts-permission',
  subState: 'synapse:sub-state',
  uiMuted: 'synapse:ui-muted',
} as const;

export const ACTIVATION_STORAGE_KEY = KEYS.activation;
export const UI_MUTED_STORAGE_KEY = KEYS.uiMuted;

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

/**
 * The "hide UI" valve (docs/ROADMAP.md §11.4) — deliberately a SEPARATE axis from activation. A
 * script whose logic is useful but whose on-page UI is in the way should be muteable without being
 * switched off; collapsing the two would make "make this stop drawing" and "stop running this" the
 * same button, which is the reason the valve exists at all.
 *
 * Absent entry = not muted, so existing installs are unaffected (contrast with the activation
 * default flip discussed in §12.4, which does change behaviour and needs a migration).
 */
export async function getUiMutedMap(): Promise<Record<string, boolean>> {
  return getStored(KEYS.uiMuted, {});
}

export async function isUiMuted(id: string): Promise<boolean> {
  return (await getUiMutedMap())[id] ?? false;
}

export async function setUiMuted(id: string, muted: boolean): Promise<void> {
  const map = await getUiMutedMap();
  map[id] = muted;
  await setStored(KEYS.uiMuted, map);
}

// There is deliberately no `isUiVisible()` combining the two flags. It existed briefly and ended up
// with zero callers, because the flags are enforced at different layers and must stay that way:
// activation decides whether a Module DRAWS at all, mute decides whether what it drew is DISPLAYED
// (utils/ui-compositor.ts, via a DOM attribute the USER_SCRIPT world can also read). Collapsing them
// into one question at the call site is what made the valve one-way — hiding tore the surfaces down
// and nothing could put an uploaded script's UI back.

/**
 * What the user approved for one uploaded script, plus the hash of the source they approved it for
 * (docs/ROADMAP.md §11.3 constraint D). Grants are stored ONLY for uploaded scripts — a bundled
 * Module's grant is derived from its own build-time `scopes` declaration and never written here,
 * so no auto-grant branch can reach an uploaded id, and there is nothing first-party in this
 * record for a future bug to widen.
 */
export interface StoredGrantRecord {
  scopes: SynapseScopeGrant[];
  /** SHA-256 of the source that was on screen when consent was given. `getGrantedScopes` returns
   * `[]` when the current source hashes differently, which is Tampermonkey's behaviour on script
   * update: consent is for a specific piece of code, not for a name. Today every upload mints a
   * fresh id so a mismatch can't arise yet — this is what makes an update path safe by
   * construction when one is added, rather than something to remember at that point. */
  sourceHash: string;
}

/**
 * Reads the grants map, dropping any record left over from the retired Capability model
 * (docs/ROADMAP.md §11.3). The legacy shape was `Record<id, ('net'|'ai'|'cache'|'bus'|'dom')[]>`;
 * those names have no honest translation into scopes — `cache` in particular WAS the escalation
 * hole — so they are discarded rather than mapped, and the user is asked again. That old map also
 * held auto-granted bundled entries, which no longer belong in storage at all.
 */
export async function getGrantsMap(): Promise<Record<string, StoredGrantRecord>> {
  const raw = await getStored<Record<string, unknown>>(KEYS.grants, {});
  const map: Record<string, StoredGrantRecord> = {};
  let migrated = false;

  for (const [id, value] of Object.entries(raw)) {
    if (isGrantRecord(value)) {
      map[id] = value;
    } else {
      migrated = true; // legacy Capability[] (or anything unrecognizable) — drop it
    }
  }

  if (migrated) await setStored(KEYS.grants, map);
  return map;
}

function isGrantRecord(value: unknown): value is StoredGrantRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { scopes?: unknown; sourceHash?: unknown };
  return Array.isArray(v.scopes) && typeof v.sourceHash === 'string';
}

/** The scopes actually in force for an uploaded script: `[]` unless a record exists AND it was
 * approved for exactly this source. The single read-side authority — `rpc-handler.ts` and the
 * Registry both go through it so neither can forget the hash check. */
export async function getGrantedScopes(id: string, sourceHash: string): Promise<SynapseScopeGrant[]> {
  const record = (await getGrantsMap())[id];
  if (!record || record.sourceHash !== sourceHash) return [];
  return record.scopes;
}

export async function setGrantedScopes(id: string, scopes: SynapseScopeGrant[], sourceHash: string): Promise<void> {
  const map = await getGrantsMap();
  map[id] = { scopes, sourceHash };
  await setStored(KEYS.grants, map);
}

export async function deleteGrantRecord(id: string): Promise<void> {
  const map = await getGrantsMap();
  delete map[id];
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
