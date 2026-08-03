// Demonstrates `steps` (docs/ROADMAP.md §12.3) — a script with more than one logical stage,
// instead of a single `run`. Each step's return value becomes the next step's `input`, in
// declared order; open this script in Studio (its "Edit in Studio" icon in the popup) to see the
// Steps sidebar next to the editor.
//
// To test the per-step bypass: in Studio's sidebar, uncheck "Double it" and reload the page this
// script runs on — the log below will show the ORIGINAL word count reaching the last step
// unchanged, instead of the doubled one.
__synapseModule = {
  id: 'steps-test',
  scopes: ['storage.rw'],
  steps: [
    {
      id: 'count-words',
      label: 'Count words on the page',
      async run() {
        const count = document.body.innerText.trim().split(/\s+/).filter(Boolean).length;
        console.log('[steps] count-words ->', count);
        return count;
      },
    },
    {
      id: 'double-it',
      label: 'Double it',
      async run(count) {
        const doubled = count * 2;
        console.log('[steps] double-it ->', doubled);
        return doubled;
      },
    },
    {
      id: 'save-result',
      label: 'Save to storage',
      async run(value, ctx) {
        await ctx.api.storage.set('last-steps-result', value);
        console.log('[steps] save-result -> stored', value, '(read it back with storage.get in another run)');
        return value;
      },
    },
  ],
};
