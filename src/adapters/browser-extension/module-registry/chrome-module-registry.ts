import { validateModuleManifestShape } from '../../../kernel/manifest-validator';
import type { ModuleRegistryService, RegistryEntry, UploadResult } from '../../../kernel/module-registry';
import type { SynapseScopeGrant } from '../../../kernel/synapse-api';
import { hashScriptSource } from '../../../shared/source-hash';
import { BUNDLED_MODULES } from './bundled-modules';
import { BACKGROUND_MODULES } from './background-modules';
import { buildShimSource } from './user-script-shim';
import {
  getActivationMap,
  getGrantsMap,
  getManifestReports,
  getSubStateMap,
  getUploadedSources,
  setGrantedScopes,
  setModuleActive,
  setSubModuleActive as persistSubModuleActive,
  setUploadedSource,
  type StoredGrantRecord,
  type StoredManifestReport,
} from './storage';

/**
 * Best-effort nudge so a bus-needing Module's `run()` re-checks `isModuleActive` right away instead
 * of only on its next unrelated bus event or the next service-worker restart (docs/ROADMAP.md #4
 * Part B) — every such Module (http-error-mocker, network-sniffer, iframe-unsandbox) already
 * re-gates on `isModuleActive` before doing anything, on ANY command shape including this bare
 * `{op:'sync'}`, so this is safe generically. A Module without a 'bus' listener for this id (i.e.
 * one that doesn't declare `needs: ['bus']`) simply has no listener to receive it — a harmless
 * no-op, not an error.
 */
function pingBusModule(id: string): void {
  chrome.runtime.sendMessage({ event: id, payload: { op: 'sync' } }).catch(() => {});
}

async function registerUploadedScript(id: string, source: string): Promise<void> {
  const shimmed = buildShimSource(id, source);
  await chrome.userScripts.register([
    { id, js: [{ code: shimmed }], matches: ['<all_urls>'], world: 'USER_SCRIPT' },
  ]);
}

/**
 * ModuleRegistryService (docs/design.md §1 Port pattern) backed by chrome.storage +
 * chrome.userScripts, merging build-time bundled Modules with runtime-uploaded ones.
 */
export class ChromeModuleRegistryService implements ModuleRegistryService {
  async list(): Promise<RegistryEntry[]> {
    return this.buildEntries();
  }

  async refresh(): Promise<RegistryEntry[]> {
    return this.buildEntries();
  }

  async activate(id: string): Promise<void> {
    const uploaded = await getUploadedSources();
    if (id in uploaded) {
      try {
        await registerUploadedScript(id, uploaded[id]!);
      } catch {
        // Already registered (e.g. re-activating without a prior deactivate) — best-effort, ignore.
      }
    }
    await setModuleActive(id, true);
    pingBusModule(id);
  }

  async deactivate(id: string): Promise<void> {
    const uploaded = await getUploadedSources();
    if (id in uploaded) {
      await chrome.userScripts.unregister({ ids: [id] });
    }
    await setModuleActive(id, false);
    pingBusModule(id);
  }

  /**
   * Records consent, bound to the exact source it was given for (docs/ROADMAP.md §11.3 constraint
   * D). Refuses any id that isn't an uploaded script: a bundled Module's grant is derived from its
   * own build-time `scopes` declaration in `buildBundledEntries`, and writing first-party
   * permissions into storage is what made the old model's auto-grant and the escalation hole
   * reachable from the same place.
   */
  async grantScopes(id: string, scopes: SynapseScopeGrant[]): Promise<void> {
    const uploaded = await getUploadedSources();
    const source = uploaded[id];
    if (source === undefined) return;
    await setGrantedScopes(id, scopes, await hashScriptSource(source));
  }

  async setSubModuleActive(id: string, subId: string, active: boolean): Promise<void> {
    await persistSubModuleActive(id, subId, active);
  }

  async uploadModule(source: string): Promise<UploadResult> {
    const id = crypto.randomUUID();
    try {
      await registerUploadedScript(id, source);
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    await setUploadedSource(id, source);
    await setModuleActive(id, true);

    const entries = await this.buildEntries();
    const entry = entries.find((e) => e.id === id);
    return entry ? { ok: true, entry } : { ok: true };
  }

  private async buildEntries(): Promise<RegistryEntry[]> {
    const [activation, grants, uploaded, reports, subStates] = await Promise.all([
      getActivationMap(),
      getGrantsMap(),
      getUploadedSources(),
      getManifestReports(),
      getSubStateMap(),
    ]);

    const bundled = this.buildBundledEntries(activation, subStates);
    const uploadedEntries = await this.buildUploadedEntries(uploaded, reports, activation, grants);
    const entries = [...bundled, ...uploadedEntries];

    const idCounts = new Map<string, number>();
    for (const entry of entries) idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1);
    for (const entry of entries) {
      if ((idCounts.get(entry.id) ?? 0) > 1) {
        entry.status = 'invalid';
        entry.reason = `duplicate id "${entry.id}"`;
      }
    }

    return entries;
  }

  private buildBundledEntries(
    activation: Record<string, boolean>,
    subStates: Record<string, Record<string, boolean>>,
  ): RegistryEntry[] {
    const entries: RegistryEntry[] = [];
    // Merges dom Modules (bundled-modules.ts) with browser-specific non-dom Modules
    // (background-modules.ts, e.g. http-error-mocker) — both are trusted build-time code and get
    // the same RegistryEntry treatment (Navigation Flow's Gear/Arrow icon applies to either).
    for (const mod of [...BUNDLED_MODULES, ...BACKGROUND_MODULES]) {
      // Bundled = trusted build-time code, so what it declares IS what it's granted — derived
      // here on every read rather than persisted, which keeps first-party permissions entirely
      // out of chrome.storage and means editing a Module's declaration takes effect on rebuild
      // instead of leaving a stale grant behind.
      const scopes = mod.scopes ?? [];

      const entry: RegistryEntry = {
        id: mod.id,
        source: 'bundled',
        scopes,
        active: activation[mod.id] ?? true,
        status: 'ok',
        grantedScopes: scopes,
      };
      if (mod.uiSchema) entry.uiSchema = mod.uiSchema;
      if (mod.uiParadigm) entry.uiParadigm = mod.uiParadigm;
      if (mod.label) entry.label = mod.label;
      if (mod.description) entry.description = mod.description;
      if (mod.subModules) {
        entry.subModules = mod.subModules;
        entry.subState = subStates[mod.id] ?? {};
      }

      entries.push(entry);
    }
    return entries;
  }

  private async buildUploadedEntries(
    uploaded: Record<string, string>,
    reports: Record<string, StoredManifestReport>,
    activation: Record<string, boolean>,
    grants: Record<string, StoredGrantRecord>,
  ): Promise<RegistryEntry[]> {
    return Promise.all(
      Object.keys(uploaded).map((id) =>
        this.buildUploadedEntry(id, uploaded[id]!, reports[id], activation, grants),
      ),
    );
  }

  private async buildUploadedEntry(
    id: string,
    source: string,
    report: StoredManifestReport | undefined,
    activation: Record<string, boolean>,
    grants: Record<string, StoredGrantRecord>,
  ): Promise<RegistryEntry> {
    // Same hash check the RPC handler enforces (storage.ts's getGrantedScopes): a grant approved
    // for different source code counts as no grant, so the UI shows what will actually happen.
    const record = grants[id];
    const grantedScopes =
      record && record.sourceHash === (await hashScriptSource(source)) ? record.scopes : [];
    const active = activation[id] ?? true;

    // No report yet (script hasn't run on a matching page since upload) — optimistic 'ok',
    // graceful-fail layer 2/3 (run-time + shape) resolve once a report arrives.
    if (!report) {
      return { id, source: 'uploaded', scopes: [], active, status: 'ok', grantedScopes };
    }

    if (report.runError) {
      return { id, source: 'uploaded', scopes: [], active, status: 'invalid', reason: report.runError, grantedScopes };
    }
    if (!report.hasRun) {
      return { id, source: 'uploaded', scopes: [], active, status: 'invalid', reason: 'globalThis.__synapseModule.run is not a function', grantedScopes };
    }

    const shapeCheck = validateModuleManifestShape({ id, scopes: report.scopes });
    if (!shapeCheck.valid) {
      return { id, source: 'uploaded', scopes: [], active, status: 'invalid', reason: shapeCheck.reason, grantedScopes };
    }

    const entry: RegistryEntry = {
      id,
      source: 'uploaded',
      scopes: shapeCheck.manifest.scopes,
      active,
      status: 'ok',
      grantedScopes,
    };
    if (typeof report.id === 'string' && report.id.length > 0) entry.label = report.id;

    return entry;
  }
}
