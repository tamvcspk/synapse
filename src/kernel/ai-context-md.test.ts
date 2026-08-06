import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildAiContextMd } from './ai-context-md';
import pkg from '../../package.json';

const userScriptsGuide = readFileSync(fileURLToPath(new URL('../../docs/user-scripts.md', import.meta.url)), 'utf8');
const typeReference = readFileSync(fileURLToPath(new URL('../../docs/types/synapse-userscript.d.ts', import.meta.url)), 'utf8');

// Fixed, not `new Date()` — this drives a snapshot that must stay byte-stable across days with no
// real content change. The live Help page (ui/help/main.ts) passes today's real date instead.
const generatedAt = '2026-08-06';

const generated = buildAiContextMd({ version: pkg.version, generatedAt, userScriptsGuide, typeReference });

/**
 * The downloadable bundle is generated, same discipline as `userscript-dts.test.ts` enforces for
 * the `.d.ts` output — run `npm test -- -u` to update `docs/synapse-ai-context.md` after either
 * source file changes.
 */
describe('generated AI context bundle', () => {
  it('matches the checked-in docs/synapse-ai-context.md', async () => {
    await expect(generated).toMatchFileSnapshot('../../docs/synapse-ai-context.md');
  });

  it('carries the real package version and a generation date', () => {
    expect(generated).toContain(`Synapse v${pkg.version}`);
    expect(generated).toContain(generatedAt);
  });

  it('embeds the user-scripts guide verbatim', () => {
    expect(generated).toContain('Three rules that are not style preferences');
  });

  it('embeds the full type reference verbatim, fenced', () => {
    expect(generated).toContain('interface SynapseApi');
    expect(generated).toMatch(/```typescript\n[\s\S]*interface SynapseApi[\s\S]*```/);
  });

  it('places silent-failure guidance before the API reference (docs/ROADMAP.md §11.6)', () => {
    const rulesIndex = generated.indexOf('Three rules that are not style preferences');
    const referenceIndex = generated.indexOf('## Full type reference');
    expect(rulesIndex).toBeGreaterThan(-1);
    expect(referenceIndex).toBeGreaterThan(-1);
    expect(rulesIndex).toBeLessThan(referenceIndex);
  });
});
