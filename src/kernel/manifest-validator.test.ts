import { describe, expect, it } from 'vitest';
import { validateModuleManifestShape } from './manifest-validator';

/**
 * The only validation possible for a manifest that didn't come through TypeScript — an uploaded
 * user script's `globalThis.__synapseModule`, reported back over messaging.
 */
describe('validateModuleManifestShape', () => {
  it('accepts a minimal manifest with no scopes', () => {
    expect(validateModuleManifestShape({ id: 'my-script' })).toEqual({
      valid: true,
      manifest: { id: 'my-script', scopes: [] },
    });
  });

  it('normalizes declared scopes to the persisted object form', () => {
    expect(validateModuleManifestShape({ id: 'x', scopes: ['storage.rw'] })).toEqual({
      valid: true,
      manifest: { id: 'x', scopes: [{ scope: 'storage.rw' }] },
    });
  });

  it('rejects a missing or empty id', () => {
    expect(validateModuleManifestShape({ scopes: [] })).toMatchObject({ valid: false });
    expect(validateModuleManifestShape({ id: '' })).toMatchObject({ valid: false });
    expect(validateModuleManifestShape(null)).toMatchObject({ valid: false });
    expect(validateModuleManifestShape('my-script')).toMatchObject({ valid: false });
  });

  it('rejects an unknown scope, naming it in the reason so the popup can show why', () => {
    const result = validateModuleManifestShape({ id: 'x', scopes: ['media.everything'] });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toContain('media.everything');
  });

  it('IGNORES fields from retired models rather than rejecting the script', () => {
    // `needs` (the Capability model, §11.3) and `supportedEnvs` (the second Adapter, §11.1) both
    // appear in scripts written against older versions. Same posture as any other unknown field.
    expect(validateModuleManifestShape({ id: 'x', needs: ['cache', 'bus'], supportedEnvs: ['browser'] })).toEqual({
      valid: true,
      manifest: { id: 'x', scopes: [] },
    });
  });

  it('does not carry a retired `needs` declaration over into scopes — an old script gets zero permissions, not guessed ones', () => {
    const result = validateModuleManifestShape({ id: 'x', needs: ['cache'] });
    expect(result.valid && result.manifest.scopes).toEqual([]);
  });
});
