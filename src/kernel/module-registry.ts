import type { Capability } from './module';
import type { UISchema } from './ui-schema';

export type ModuleSource = 'bundled' | 'uploaded';
/** `'env-mismatch'` is gone with the Environment Guard (docs/ROADMAP.md §11.1) — a Module can no
 * longer be well-formed but unrunnable here, so "invalid" is the only remaining not-ok state. */
export type ModuleStatus = 'ok' | 'invalid';

export interface RegistryEntry {
  id: string;
  /** Human-friendly display name. For uploaded modules this is the script's self-declared
   * __synapseModule.id, only known once its first ManifestReport arrives — until then, absent
   * and the UI falls back to `id` (the extension-assigned registration id). */
  label?: string;
  /** Mirrors Module.description (bundled only — uploaded modules have no self-declared
   * description channel today, unlike `label`'s ManifestReport `__synapseModule.id`). */
  description?: string;
  source: ModuleSource;
  needs: Capability[];
  active: boolean;
  status: ModuleStatus;
  reason?: string;
  grantedCapabilities: Capability[];
  /** Mirrors Module.uiSchema — presence drives the popup's Gear/Arrow icon (docs/ROADMAP.md #2). */
  uiSchema?: UISchema;
  /** Mirrors Module.subModules (docs/ROADMAP.md #3) — presence drives the popup's per-step
   * bypass toggles for a Composite Module. */
  subModules?: { id: string; label?: string }[];
  /** Per-step bypass state for a Composite Module's `subModules` — keyed by sub-module id, `false`
   * means that step is skipped (docs/ROADMAP.md #3). A step missing from this map is treated as
   * active (not bypassed). Absent entirely when `subModules` is absent. */
  subState?: Record<string, boolean>;
  /** Mirrors Module.uiParadigm (docs/ROADMAP.md §4.2) — presence of `'float-widget'` is what
   * drives the popup's on-page-alerts hint. Absent for a Module that declares no paradigm. */
  uiParadigm?: 'none' | 'dedicated-page' | 'float-widget' | 'action-button';
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
  uploadModule(source: string): Promise<UploadResult>;
  grantCapabilities(id: string, capabilities: Capability[]): Promise<void>;
  refresh(): Promise<RegistryEntry[]>;
  /** Toggles one sub-module's bypass state on a Composite Module (docs/ROADMAP.md #3). Only
   * meaningful for a `RegistryEntry` whose `subModules` includes `subId`. */
  setSubModuleActive(id: string, subId: string, active: boolean): Promise<void>;
}
