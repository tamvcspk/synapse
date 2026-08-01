// Synapse Phase 2 verification — script B of 2 (docs/ROADMAP.md §11.3).
// Upload alongside synapse-test-a.js. See that file's header for what the pair proves.
//
// B declares ONLY `storage.rw`, so it is the one to test Deny → Grant against. It also captures
// `ctx.api` into a module-level variable, which is the pattern for reaching the platform outside
// run() (from an event handler, say) now that there is no global to reach for.

const SYNAPSE_TEST_MARKER = 'B'; // same identifier as script A — that collision is the point

const panel = createPanel('B', '#c50', 210);
panel.line('injected + evaluated', 'yes ✅ (this line needs no permission at all)');
panel.line('marker seen by THIS script', SYNAPSE_TEST_MARKER);

let api; // captured from ctx below — the supported way to use the API outside run()

globalThis.__synapseModule = {
  id: 'synapse-test-b',
  scopes: ['storage.rw'],

  async run(input, ctx) {
    api = ctx.api;
    panel.line('run() called', 'yes ✅');

    const probe = async (label, fn) => {
      try {
        panel.line(label, format(await fn()));
      } catch (err) {
        // Expected before Grant: 'Scope "storage.rw" is not granted for module "<uuid>"'.
        // An error here is a PASS for the deny case; a silent success would be the failure.
        panel.line(label, `⛔ ${err.message}`);
      }
    };

    await probe('run count', async () => {
      const runs = ((await api.storage.get('runs')) ?? 0) + 1;
      await api.storage.set('runs', runs);
      return runs;
    });

    await probe("shared-key (must NOT be 'written-by-A')", async () => {
      await api.storage.set('shared-key', 'written-by-B');
      return api.storage.get('shared-key');
    });

    await probe('own keys', () => api.storage.keys());

    return { ok: true };
  },
};

function createPanel(name, color, topPx) {
  const lines = [`SYNAPSE TEST ${name}`];
  const box = document.createElement('div');
  box.style.cssText = [
    'position:fixed', `top:${topPx}px`, 'right:12px', 'z-index:2147483647',
    'max-width:470px', 'padding:10px 12px', 'border-radius:8px',
    `border:2px solid ${color}`, 'background:#111', 'color:#eee',
    'font:12px/1.45 ui-monospace,Consolas,monospace', 'white-space:pre-wrap',
    'box-shadow:0 4px 16px rgba(0,0,0,.5)',
  ].join(';');
  const body = document.createElement('pre');
  body.style.cssText = 'margin:0;font:inherit;white-space:pre-wrap';

  const close = document.createElement('button');
  close.textContent = '×';
  close.title = 'Dismiss';
  close.style.cssText = `position:absolute;top:2px;right:6px;border:0;background:transparent;color:${color};font:16px/1 monospace;cursor:pointer;padding:2px 4px`;
  close.addEventListener('click', () => box.remove());
  box.append(close, body);

  const mount = () => (document.body ?? document.documentElement).appendChild(box);
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });

  return {
    line(label, value) {
      lines.push(`${label}: ${typeof value === 'string' ? value : format(value)}`);
      body.textContent = lines.join('\n');
      console.log(`[synapse-test-${name}] ${label}:`, value);
    },
  };
}

function format(value) {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
