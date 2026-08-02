import { validateModuleManifestShape } from '../../../kernel/manifest-validator';
import type { ModuleRegistryService, RegistryEntry, UploadResult } from '../../../kernel/module-registry';
import type { SynapseScopeGrant } from '../../../kernel/synapse-api';
import { hashScriptSource } from '../../../shared/source-hash';
import { resolveScriptLabel } from '../../../shared/resolve-script-label';
import { BUNDLED_MODULES } from './bundled-modules';
import { BACKGROUND_MODULES } from './background-modules';
import { buildShimSource } from './user-script-shim';
// `&iife`, not `&module` — same reason as network-sniffer.background.ts's MAIN-world payload
// import: chrome.userScripts, like chrome.scripting, injects `js` entries as classic scripts, and a
// raw ES module chunk throws a SyntaxError before a single line runs.
import libPayloadPath from './user-script-lib-payload?script&iife';
import { clearScriptStorage } from './script-storage';
import {
  getActivationMap,
  getGrantsMap,
  getManifestReports,
  getScriptMetaMap,
  getSubStateMap,
  getUploadedSources,
  setGrantedScopes,
  setModuleActive,
  getUiMutedMap,
  setUiMuted as persistUiMuted,
  setSubModuleActive as persistSubModuleActive,
  setUploadedSource,
  setScriptMeta,
  deleteActivation,
  deleteGrantRecord,
  deleteManifestReport,
  deleteScriptMeta,
  deleteSubState,
  deleteUploadedSource,
  type ScriptMeta,
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
  // `lib.*`'s payload (docs/api-inventory.md §3.0) is listed FIRST — same ordering guarantee
  // `content_scripts.js` arrays give, entries run in order in one execution — so by the time the
  // shim's own header runs, globalThis.__synapseLib is already set for it to capture.
  await chrome.userScripts.register([
    { id, js: [{ file: libPayloadPath }, { code: shimmed }], matches: ['<all_urls>'], world: 'USER_SCRIPT' },
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

  /**
   * The "hide UI" valve (docs/ROADMAP.md §11.4). Deliberately does NOT touch activation or ping the
   * Module: the point is that its logic keeps running. Open pages pick the change up through
   * `ui-visibility.ts`'s storage listener, so nothing needs to be re-registered here.
   */
  async setUiHidden(id: string, hidden: boolean): Promise<void> {
    await persistUiMuted(id, hidden);
  }

  async uploadModule(source: string, fileName?: string): Promise<UploadResult> {
    const id = crypto.randomUUID();
    try {
      await registerUploadedScript(id, source);
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    await setUploadedSource(id, source);
    await setModuleActive(id, true);
    const now = Date.now();
    await setScriptMeta(id, { ...(fileName ? { fileName } : {}), createdAt: now, updatedAt: now });

    const entries = await this.buildEntries();
    const entry = entries.find((e) => e.id === id);
    return entry ? { ok: true, entry } : { ok: true };
  }

  /** Refuses bundled ids — same reasoning as `grantScopes`: a bundled Module's label comes from its
   * own build-time code, and writing here would put a first-party display name in a store scripts
   * might one day reach. */
  async renameScript(id: string, label: string): Promise<void> {
    const uploaded = await getUploadedSources();
    if (!(id in uploaded)) return;
    const meta = (await getScriptMetaMap())[id];
    await setScriptMeta(id, { ...meta, userLabel: label, createdAt: meta?.createdAt ?? Date.now(), updatedAt: Date.now() });
  }

  async getUploadedSource(id: string): Promise<string | undefined> {
    return (await getUploadedSources())[id];
  }

  /** "7 places, one function" (docs/ROADMAP.md §12.1) — deliberately gathered here rather than left
   * for the UI to call piecemeal, so no future caller can partially delete a script and leave ghost
   * state behind. A no-op for a bundled id: nothing here belongs to one. */
  async deleteScript(id: string): Promise<void> {
    const uploaded = await getUploadedSources();
    if (!(id in uploaded)) return;

    try {
      await chrome.userScripts.unregister({ ids: [id] });
    } catch {
      // Already unregistered (e.g. deleting a script that's currently deactivated) — best-effort.
    }

    await Promise.all([
      deleteUploadedSource(id),
      deleteScriptMeta(id),
      deleteManifestReport(id),
      deleteGrantRecord(id),
      deleteActivation(id),
      deleteSubState(id),
      clearScriptStorage(id),
    ]);
  }

  private async buildEntries(): Promise<RegistryEntry[]> {
    const [activation, grants, uploaded, reports, subStates, uiMuted, scriptMeta] = await Promise.all([
      getActivationMap(),
      getGrantsMap(),
      getUploadedSources(),
      getManifestReports(),
      getSubStateMap(),
      getUiMutedMap(),
      getScriptMetaMap(),
    ]);

    const bundled = this.buildBundledEntries(activation, subStates, uiMuted);
    const uploadedEntries = await this.buildUploadedEntries(uploaded, reports, activation, grants, uiMuted, scriptMeta);
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
    uiMuted: Record<string, boolean>,
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
        uiHidden: uiMuted[mod.id] ?? false,
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
    uiMuted: Record<string, boolean>,
    scriptMeta: Record<string, ScriptMeta>,
  ): Promise<RegistryEntry[]> {
    return Promise.all(
      Object.keys(uploaded).map((id) =>
        this.buildUploadedEntry(id, uploaded[id]!, reports[id], activation, grants, uiMuted, scriptMeta[id]),
      ),
    );
  }

  private async buildUploadedEntry(
    id: string,
    source: string,
    report: StoredManifestReport | undefined,
    activation: Record<string, boolean>,
    grants: Record<string, StoredGrantRecord>,
    uiMuted: Record<string, boolean>,
    meta: ScriptMeta | undefined,
  ): Promise<RegistryEntry> {
    // Same hash check the RPC handler enforces (storage.ts's getGrantedScopes): a grant approved
    // for different source code counts as no grant, so the UI shows what will actually happen.
    const record = grants[id];
    const grantedScopes =
      record && record.sourceHash === (await hashScriptSource(source)) ? record.scopes : [];
    const active = activation[id] ?? true;
    const uiHidden = uiMuted[id] ?? false;
    // docs/ROADMAP.md §12.0's 4-tier fallback — always resolves to SOMETHING displayable, even
    // before a script has ever run (unlike the old report.id-only label, which left the popup
    // showing a raw uuid until the first ManifestReport arrived).
    const label = resolveScriptLabel(id, {
      userLabel: meta?.userLabel,
      reportLabel: typeof report?.id === 'string' && report.id.length > 0 ? report.id : undefined,
      fileName: meta?.fileName,
    });
    // exactOptionalPropertyTypes: only spread `fileName` in when there's a real string to give it.
    const fileNameField = meta?.fileName ? { fileName: meta.fileName } : {};

    // No report yet (script hasn't run on a matching page since upload) — optimistic 'ok',
    // graceful-fail layer 2/3 (run-time + shape) resolve once a report arrives.
    if (!report) {
      return { id, label, ...fileNameField, source: 'uploaded', scopes: [], active, status: 'ok', grantedScopes, uiHidden };
    }

    if (report.runError) {
      return { id, label, ...fileNameField, source: 'uploaded', scopes: [], active, status: 'invalid', reason: report.runError, grantedScopes, uiHidden };
    }
    if (!report.hasRun) {
      return { id, label, ...fileNameField, source: 'uploaded', scopes: [], active, status: 'invalid', reason: 'globalThis.__synapseModule.run is not a function', grantedScopes, uiHidden };
    }

    const shapeCheck = validateModuleManifestShape({ id, scopes: report.scopes });
    if (!shapeCheck.valid) {
      return { id, label, ...fileNameField, source: 'uploaded', scopes: [], active, status: 'invalid', reason: shapeCheck.reason, grantedScopes, uiHidden };
    }

    return {
      id,
      label,
      ...fileNameField,
      source: 'uploaded',
      scopes: shapeCheck.manifest.scopes,
      active,
      status: 'ok',
      grantedScopes,
      uiHidden,
    };
  }
}
