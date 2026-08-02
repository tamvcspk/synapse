// Synapse Phase 2 verification — script A of 2 (docs/ROADMAP.md §11.3).
// Upload BOTH this and synapse-test-b.js from the popup, then open any ordinary http(s) page.
//
// What the pair is designed to catch:
//  1. Top-level `const SYNAPSE_TEST_MARKER` is declared with the SAME identifier in both files.
//     Every registered user script shares one USER_SCRIPT world, so before the shim's IIFE fix
//     the second script evaluated died with a redeclaration SyntaxError and never ran.
//  2. Both scripts write the SAME user key ('shared-key'). Each must read back only its own.
//  3. This script tries to read/write the extension's own records; reads must be undefined and
//     the write must land inside this script's namespace, not on the real record.
//
// The panel is drawn SYNCHRONOUSLY here, before `run()` and before any await, so that "the script
// never ran" and "the script ran but run() failed" cannot look the same. Every later result is
// appended to it, and nothing below is allowed to throw past the reporter.

const SYNAPSE_TEST_MARKER = 'A';

const panel = createPanel('A', '#0b5', 12);
panel.line('injected + evaluated', 'yes ✅ (this line needs no permission at all)');

__synapseModule = {
  id: 'synapse-test-a',
  scopes: ['storage.rw', 'page.dom'],

  async run(input, ctx) {
    const api = ctx.api; // the ONLY handle — see the global-stub probe at the end
    panel.line('run() called', 'yes ✅');

    // Each probe reports its own outcome. Before the user presses Grant every one of these
    // rejects with 'Scope "storage.rw" is not granted …' — that error IS the pass for the deny
    // case, so it must be visible rather than aborting the run.
    const probe = async (label, fn) => {
      try {
        panel.line(label, format(await fn()));
      } catch (err) {
        panel.line(label, `⛔ ${err.message}`);
      }
    };

    // --- persistence across page loads ---------------------------------------------------
    await probe('run count (should grow on reload)', async () => {
      const runs = ((await api.storage.get('runs')) ?? 0) + 1;
      await api.storage.set('runs', runs);
      return runs;
    });

    // --- namespace isolation between scripts ---------------------------------------------
    await probe("shared-key (B writes this key too)", async () => {
      await api.storage.set('shared-key', 'written-by-A');
      return api.storage.get('shared-key');
    });

    // --- privilege-escalation attempt (the hole Phase 2 closed) ---------------------------
    // These keys exist in chrome.storage.local. From inside a script they must be invisible.
    await probe("read 'synapse:grants' BEFORE writing", () => api.storage.get('synapse:grants'));
    await probe("read 'synapse:uploaded'", () => api.storage.get('synapse:uploaded'));
    await probe("read 'synapse:activation'", () => api.storage.get('synapse:activation'));

    // After this write the read is non-undefined — but it is THIS SCRIPT'S key. Confirm the real
    // record is untouched in the service worker console:
    //   chrome.storage.local.get('synapse:grants', console.log)
    await probe("read 'synapse:grants' AFTER writing it", async () => {
      await api.storage.set('synapse:grants', { hijacked: true });
      return api.storage.get('synapse:grants');
    });

    // --- remove + keys --------------------------------------------------------------------
    await probe('own keys (scratch must be absent)', async () => {
      await api.storage.set('scratch', 1);
      await api.storage.remove('scratch');
      return api.storage.keys();
    });

    // --- identity: the old global must NOT work ------------------------------------------
    // One shared world = one `globalThis.synapseApi` binding for every script, so it cannot carry
    // per-script identity. It must reject with an explanation, never quietly act as script B.
    await probe('globalThis.synapseApi (must be ⛔ refused)', () => globalThis.synapseApi.storage.get('runs'));

    return { ok: true };
  },
};

/**
 * `page.dom` is a Disclosed scope: this works whether or not it was granted, which is exactly why
 * the consent UI lists it apart from the enforced ones instead of implying refusal would stop it.
 */
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
  if (value === undefined) return 'undefined ✅';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
