import type { Capability, RuntimeEnv } from './module';
import type { UISchema } from './ui-schema';

export type ModuleSource = 'bundled' | 'uploaded';
export type ModuleStatus = 'ok' | 'invalid' | 'env-mismatch';

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
  supportedEnvs: RuntimeEnv[];
  active: boolean;
  envSupported: boolean;
  status: ModuleStatus;
  reason?: string;
  grantedCapabilities: Capability[];
  /** Mirrors Module.uiSchema — presence drives the popup's Gear/Arrow icon (docs/ROADMAP.md #2). */
  uiSchema?: UISchema;
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
}
