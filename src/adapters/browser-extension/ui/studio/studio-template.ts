/** "New script" starting point (docs/ROADMAP.md §12.2) — the same shape as `docs/user-scripts.md`'s
 * first example, kept in sync by hand (that doc is prose for a human reader; this is what Studio
 * actually loads, so drifting apart silently would be confusing rather than dangerous either way). */
export const NEW_SCRIPT_TEMPLATE = `__synapseModule = {
  id: 'my-script',
  scopes: ['storage.rw'],

  async run(input, ctx) {
    const seen = (await ctx.api.storage.get('run-count')) ?? 0;
    await ctx.api.storage.set('run-count', seen + 1);
    console.log(\`Run #\${seen + 1}\`);
  },
};
`;
