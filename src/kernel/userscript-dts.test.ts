import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildUserscriptDts } from './userscript-dts';

const apiSource = readFileSync(fileURLToPath(new URL('./synapse-api.ts', import.meta.url)), 'utf8');
const generated = buildUserscriptDts(apiSource);

/**
 * The published types are generated, and this is what keeps them that way (docs/ROADMAP.md §11.3).
 * Changing `synapse-api.ts` or the scope catalog without regenerating fails here — run
 * `npm test -- -u` to update `docs/types/synapse-userscript.d.ts`.
 */
describe('generated user script types', () => {
  it('matches the checked-in docs/types/synapse-userscript.d.ts', async () => {
    await expect(generated).toMatchFileSnapshot('../../docs/types/synapse-userscript.d.ts');
  });

  it('declares the globals a script actually gets, not module exports', () => {
    expect(generated).toContain('declare let __synapseModule: SynapseUserScriptManifest;');
    // There is no `synapseApi` global to declare — see the shim's guard stub.
    expect(generated).not.toContain('declare const synapseApi');
    // An `export` would turn the .d.ts into a module and stop these being ambient globals.
    expect(generated).not.toMatch(/^export /m);
  });

  it('carries every scope and method from the catalog, so the reference cannot silently lose one', () => {
    expect(generated).toContain('`storage.rw`');
    expect(generated).toContain('synapseApi.storage.keys()');
  });

  it('separates Enforced from Disclosed — the same honesty the consent UI owes the user', () => {
    expect(generated).toMatch(/Enforced — the call fails if the user denies it/);
    expect(generated).toMatch(/Disclosed — the script can do this anyway/);
  });

  it('fails loudly if the copy marker is removed from synapse-api.ts', () => {
    expect(() => buildUserscriptDts('interface SynapseApi {}')).toThrow(/marker/);
  });
});
