import { normalizeScopeGrants } from './scopes';
import type { SynapseScopeGrant } from './synapse-api';

export interface RawModuleManifest {
  id: string;
  scopes: SynapseScopeGrant[];
}

export type ManifestValidation =
  | { valid: true; manifest: RawModuleManifest }
  | { valid: false; reason: string };

/**
 * Hand-rolled shape check (no schema lib) — the only validation possible for a Module manifest
 * that didn't come through TypeScript/the bundler (e.g. an uploaded user script's declared
 * `__synapseModule`). Cannot check `run` is a function here: function values don't survive
 * chrome.runtime messaging, so that check happens client-side in the user-script shim instead.
 *
 * Unknown fields are ignored rather than rejected — `needs` (the retired Capability declaration,
 * docs/ROADMAP.md §11.3) and `supportedEnvs` (retired in §11.1) both land here for scripts written
 * against older versions. An unknown *scope*, by contrast, is a hard error: the whole point of
 * replacing `needs` is that a permission that quietly resolves to nothing is worse than one that
 * fails loudly.
 */
export function validateModuleManifestShape(candidate: unknown): ManifestValidation {
  if (typeof candidate !== 'object' || candidate === null) {
    return { valid: false, reason: 'manifest is not an object' };
  }

  const c = candidate as Record<string, unknown>;

  if (typeof c.id !== 'string' || c.id.length === 0) {
    return { valid: false, reason: 'manifest.id must be a non-empty string' };
  }

  const scopes = normalizeScopeGrants(c.scopes);
  if (!scopes.valid) {
    return { valid: false, reason: `manifest.scopes: ${scopes.reason}` };
  }

  return { valid: true, manifest: { id: c.id, scopes: scopes.grants } };
}
