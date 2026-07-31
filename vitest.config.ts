import { defineConfig } from 'vitest/config';

/**
 * Deliberately separate from vite.config.ts: that config is wrapped in the crxjs plugin, which
 * reads manifest.config.ts and drives a whole MV3 extension build — none of which a unit test run
 * needs, and all of which would run on every `npm test` if vitest fell back to it (its default when
 * no vitest.config.* exists).
 *
 * `environment: 'node'` is the right default because everything currently under test is Global SDK
 * (docs/design.md §9): pure, no DOM, no `chrome.*`. A future test that genuinely needs a DOM should
 * opt in per-file with a `// @vitest-environment jsdom` docblock rather than flipping this global —
 * the moment the default becomes a browser-ish environment, a `shared/` file that accidentally
 * reaches for `document` stops failing the way it should.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
