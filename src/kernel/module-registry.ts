import type { SynapseScopeGrant } from './synapse-api';
import type { UISchema } from './ui-schema';

export type ModuleSource = 'bundled' | 'uploaded';
/** `'env-mismatch'` is gone with the Environment Guard (docs/ROADMAP.md §11.1) — a Module can no
 * longer be well-formed but unrunnable here, so "invalid" is the only remaining not-ok state. */
export type ModuleStatus = 'ok' | 'invalid';

export interface RegistryEntry {
  id: string;
  /** Human-friendly display name. For a bundled Module this mirrors its build-time `label`. For an
   * uploaded script it's `resolveScriptLabel` (docs/shared/resolve-script-label.ts, docs/ROADMAP.md
   * §12.0's 4-tier fallback: user-set name → self-declared `__synapseModule.id` from the first
   * ManifestReport → filename captured at upload → the extension-assigned uuid) — always present
   * for an uploaded entry, never requires the UI to fall back to `id` itself. */
  label?: string;
  /** The filename captured at upload time (docs/ROADMAP.md §12.1), `undefined` for a bundled Module
   * or an uploaded script that predates this field. Used for download naming so a re-download keeps
   * the original filename instead of a slug of whatever the current label happens to be. */
  fileName?: string;
  /** Mirrors Module.description (bundled only — uploaded modules have no self-declared
   * description channel today, unlike `label`'s ManifestReport `__synapseModule.id`). */
  description?: string;
  source: ModuleSource;
  /** Permissions this Module asks for (docs/ROADMAP.md §11.3). A *request* — for an uploaded
   * script it's whatever the script declared, which is why it's shown, not obeyed. */
  scopes: SynapseScopeGrant[];
  active: boolean;
  status: ModuleStatus;
  reason?: string;
  /** What the user has actually approved. For `source: 'bundled'` this is derived from the
   * Module's own declaration at build time and never persisted; for `source: 'uploaded'` it comes
   * from the stored grant record, and defaults to `[]` — the two paths stay separate so an
   * auto-grant can never reach an uploaded script (docs/ROADMAP.md §11.3 constraint D). */
  grantedScopes: SynapseScopeGrant[];
  /** Mirrors Module.uiSchema — presence drives the popup's Gear/Arrow icon (docs/ROADMAP.md #2). */
  uiSchema?: UISchema;
  /** Mirrors Module.templateId (docs/ROADMAP.md §12.4) — bundled-only, drives the popup's "Clone"
   * button. An uploaded script never has one: it already has real, editable source of its own. */
  templateId?: string;
  /** Mirrors Module.subModules (docs/ROADMAP.md #3) — presence drives the popup's per-step
   * bypass toggles for a Composite Module. */
  subModules?: { id: string; label?: string }[];
  /** Per-step bypass state for a Composite Module's `subModules` — keyed by sub-module id, `false`
   * means that step is skipped (docs/ROADMAP.md #3). A step missing from this map is treated as
   * active (not bypassed). Absent entirely when `subModules` is absent. */
  subState?: Record<string, boolean>;
  /** Outcome of each step's MOST RECENT run — keyed by step id (docs/ROADMAP.md §12.3). Sourced
   * from an uploaded script's `ManifestReport.stepResults`; a bundled Composite Module never
   * populates this (its `onSubFailure` still just `console.error`s — observability was only
   * rebuilt for the Studio sidebar's case, not `steps-view.ts`'s). A step id present in
   * `subModules` but missing here just hasn't reported a run yet, which is not the same thing as
   * `skipped: true` (that means the bypass excluded it from the last run that DID happen). */
  subStepStatus?: Record<string, { ok: boolean; durationMs: number; error?: string; skipped?: boolean }>;
  /** Mirrors Module.uiParadigm (docs/ROADMAP.md §4.2) — presence of `'float-widget'` is what
   * drives the popup's on-page-alerts hint. Absent for a Module that declares no paradigm. */
  uiParadigm?: 'none' | 'dedicated-page' | 'float-widget' | 'action-button';
  /** The "hide UI" valve (docs/ROADMAP.md §11.4) — a SEPARATE axis from `active`, on purpose: a
   * Module whose logic is wanted but whose on-page widgets are in the way should be silenceable
   * without being switched off. Defaults to `false`. */
  uiHidden: boolean;
}

export interface UploadResult {
  ok: boolean;
  entry?: RegistryEntry;
  reason?: string;
}

/**
 * Port (docs/design.md §1) for discovering, activating, and granting capabilities to Modules
 * from any source — bundled at build time or uploaded at runtime. Concrete discovery/storage
 * mechanics (chrome.userScripts, chrome.storage) live entirely in the Adapter implementation.
 */
export interface ModuleRegistryService {
  list(): Promise<RegistryEntry[]>;
  activate(id: string): Promise<void>;
  deactivate(id: string): Promise<void>;
  /** `fileName` is `file.name` from the popup's file input, captured purely as a display fallback
   * (docs/ROADMAP.md §12.1) — it plays no role in identity or storage keying (that's still the
   * fresh uuid `uploadModule` mints). */
  uploadModule(source: string, fileName?: string): Promise<UploadResult>;
  /** Records the user's consent. Implementations must refuse ids that aren't uploaded scripts —
   * a bundled Module's grant is derived from code, and letting it be written would put first-party
   * permissions in a store scripts might one day reach. */
  grantScopes(id: string, scopes: SynapseScopeGrant[]): Promise<void>;
  refresh(): Promise<RegistryEntry[]>;
  /** Toggles one sub-module's bypass state on a Composite Module (docs/ROADMAP.md #3). Only
   * meaningful for a `RegistryEntry` whose `subModules` includes `subId`. */
  setSubModuleActive(id: string, subId: string, active: boolean): Promise<void>;
  /** Hides or restores one Module's in-page UI without touching whether it runs
   * (docs/ROADMAP.md §11.4). */
  setUiHidden(id: string, hidden: boolean): Promise<void>;
  /** Sets the user-chosen display name (docs/ROADMAP.md §12.1) — outranks every other fallback in
   * `resolveScriptLabel`. Implementations must refuse ids that aren't uploaded scripts, same
   * reasoning as `grantScopes`: a bundled Module's label comes from its own build-time code. */
  renameScript(id: string, label: string): Promise<void>;
  /** Raw source text for an uploaded script — `undefined` for a bundled id or an unknown id. The
   * only reason this exists on the Port is download (§12.1): the popup/Studio never otherwise need
   * the actual code, just the RegistryEntry's projection of it. */
  getUploadedSource(id: string): Promise<string | undefined>;
  /** Saves edited source for an already-uploaded script from Studio (docs/ROADMAP.md §12.2):
   * unregister + register again (the same validation `chrome.userScripts.register` does on
   * upload — a syntax error rejects and the OLD registration is restored, never left unregistered),
   * update `updatedAt`, and preserve the script's current active/inactive state either way.
   *
   * Unlike any other source-change path (§11.3 constraint D, where a source-hash mismatch means "no
   * grant"), an existing grant is REHASHED to the new source rather than dropped — §12.0's decision
   * that editing in the extension's own editor counts as "already reviewed". If the edited script
   * now requests scopes beyond what's granted, those still show up as ungranted on the next report
   * (`ungrantedScopes(entry.scopes, entry.grantedScopes)` in the popup already does this comparison;
   * nothing extra is needed here for that half).
   *
   * Refuses ids that aren't uploaded scripts, same reasoning as `grantScopes`/`renameScript`. */
  updateScriptSource(id: string, source: string): Promise<UploadResult>;
  /** Deletes an uploaded script's ENTIRE footprint — registration, source, meta, manifest report,
   * grant, activation, sub-state, and its own `storage.rw` namespace (docs/ROADMAP.md §12.1's "7
   * places, one function" — missing any one leaves ghost state, the same bug class as §8.12). A
   * no-op for a bundled id: bundled Modules aren't deletable, only toggled off. */
  deleteScript(id: string): Promise<void>;
}
