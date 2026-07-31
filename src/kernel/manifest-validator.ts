import { CAPABILITIES, type Capability } from './module';

export interface RawModuleManifest {
  id: string;
  needs: Capability[];
}

export type ManifestValidation =
  | { valid: true; manifest: RawModuleManifest }
  | { valid: false; reason: string };

/**
 * Hand-rolled shape check (no schema lib) — the only validation possible for a Module manifest
 * that didn't come through TypeScript/the bundler (e.g. an uploaded user script's declared
 * `__synapseModule`). Cannot check `run` is a function here: function values don't survive
 * chrome.runtime messaging, so that check happens client-side in the user-script shim instead.
 */
export function validateModuleManifestShape(candidate: unknown): ManifestValidation {
  if (typeof candidate !== 'object' || candidate === null) {
    return { valid: false, reason: 'manifest is not an object' };
  }

  const c = candidate as Record<string, unknown>;

  if (typeof c.id !== 'string' || c.id.length === 0) {
    return { valid: false, reason: 'manifest.id must be a non-empty string' };
  }

  const needs = c.needs === undefined ? [] : c.needs;
  if (!Array.isArray(needs) || !needs.every((n) => CAPABILITIES.includes(n as Capability))) {
    return { valid: false, reason: 'manifest.needs must be an array of valid capabilities' };
  }

  // A `supportedEnvs` left over in an older uploaded script's manifest is ignored rather than
  // rejected (docs/ROADMAP.md §11.1 removed the concept) — same posture as any other unknown field.
  return { valid: true, manifest: { id: c.id, needs: needs as Capability[] } };
}
