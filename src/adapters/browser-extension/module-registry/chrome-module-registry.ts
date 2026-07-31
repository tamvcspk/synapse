import { validateModuleManifestShape } from '../../../kernel/manifest-validator';
import type { Capability } from '../../../kernel/module';
import type { ModuleRegistryService, RegistryEntry, UploadResult } from '../../../kernel/module-registry';
import { BUNDLED_MODULES } from './bundled-modules';
import { BACKGROUND_MODULES } from './background-modules';
import { buildShimSource } from './user-script-shim';
import {
  getActivationMap,
  getGrantsMap,
  getManifestReports,
  getSubStateMap,
  getUploadedSources,
  setGrants,
  setModuleActive,
  setSubModuleActive as persistSubModuleActive,
  setUploadedSource,
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

  async grantCapabilities(id: string, capabilities: Capability[]): Promise<void> {
    await setGrants(id, capabilities);
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

    const bundled = await this.buildBundledEntries(activation, grants, subStates);
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

  private async buildBundledEntries(
    activation: Record<string, boolean>,
    grants: Record<string, Capability[]>,
    subStates: Record<string, Record<string, boolean>>,
  ): Promise<RegistryEntry[]> {
    const entries: RegistryEntry[] = [];
    // Merges dom Modules (bundled-modules.ts) with browser-specific non-dom Modules
    // (background-modules.ts, e.g. http-error-mocker) — both are trusted build-time code and get
    // the same RegistryEntry treatment (Navigation Flow's Gear/Arrow icon applies to either).
    for (const mod of [...BUNDLED_MODULES, ...BACKGROUND_MODULES]) {
      const needs = mod.needs ?? [];

      // Bundled = trusted build-time code: auto-grant declared needs the first time we see it.
      let grantedCapabilities = grants[mod.id];
      if (grantedCapabilities === undefined) {
        grantedCapabilities = needs;
        await setGrants(mod.id, grantedCapabilities);
      }

      const entry: RegistryEntry = {
        id: mod.id,
        source: 'bundled',
        needs,
        active: activation[mod.id] ?? true,
        status: 'ok',
        grantedCapabilities,
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
    grants: Record<string, Capability[]>,
  ): Promise<RegistryEntry[]> {
    const entries: RegistryEntry[] = [];
    for (const id of Object.keys(uploaded)) {
      entries.push(this.buildUploadedEntry(id, reports[id], activation, grants));
    }
    return entries;
  }

  private buildUploadedEntry(
    id: string,
    report: StoredManifestReport | undefined,
    activation: Record<string, boolean>,
    grants: Record<string, Capability[]>,
  ): RegistryEntry {
    const grantedCapabilities = grants[id] ?? [];
    const active = activation[id] ?? true;

    // No report yet (script hasn't run on a matching page since upload) — optimistic 'ok',
    // graceful-fail layer 2/3 (run-time + shape) resolve once a report arrives.
    if (!report) {
      return { id, source: 'uploaded', needs: [], active, status: 'ok', grantedCapabilities };
    }

    if (report.runError) {
      return { id, source: 'uploaded', needs: [], active, status: 'invalid', reason: report.runError, grantedCapabilities };
    }
    if (!report.hasRun) {
      return { id, source: 'uploaded', needs: [], active, status: 'invalid', reason: 'globalThis.__synapseModule.run is not a function', grantedCapabilities };
    }

    const shapeCheck = validateModuleManifestShape({ id: id, needs: report.needs });
    if (!shapeCheck.valid) {
      return { id, source: 'uploaded', needs: [], active, status: 'invalid', reason: shapeCheck.reason, grantedCapabilities };
    }

    const entry: RegistryEntry = {
      id,
      source: 'uploaded',
      needs: shapeCheck.manifest.needs,
      active,
      status: 'ok',
      grantedCapabilities,
    };
    if (typeof report.id === 'string' && report.id.length > 0) entry.label = report.id;

    return entry;
  }
}
