// Synapse Phase 3 verification — script A of 2 (docs/ROADMAP.md §11.4, the compositor).
// Upload BOTH this and synapse-ui-b.js from the popup, then open an ordinary http(s) page.
// Ideally one that sends `Content-Security-Policy: style-src 'self'` — that is the case the old
// `<style>` approach failed silently on, and the reason the compositor uses adoptedStyleSheets.
//
// What the pair is designed to catch:
//  1. Both scripts draw a toast and an icon. Both must be visible, side by side, neither
//     overwriting the other — the old shared-namespace widget host could not do this.
//  2. A deliberately tries to remove B's icon and B's toast by passing B's OWN ids. Both attempts
//     must do nothing: ids are local to a script, so A's call resolves to A's (nonexistent) surface.
//  3. A asks for three icons though the quota is two. The third call must return `false` — refused
//     out loud, not silently dropped.
//  4. A fires toasts in a burst; past the rate limit the extra calls must return `false` too.
//
// The report panel is raw DOM on purpose, drawn before anything else: if `ui.*` itself is broken,
// "the script never ran" and "the script ran and the API failed" must not look the same.

const panel = document.createElement('div');
panel.style.cssText =
  'position:fixed;left:12px;top:12px;z-index:2147483646;max-width:340px;padding:8px 10px;' +
  'background:#0b5;color:#fff;font:12px/1.5 system-ui,sans-serif;border-radius:6px;white-space:pre-wrap';
panel.textContent = 'Synapse UI test — A\n';
document.documentElement.appendChild(panel);

const line = (label, value) => {
  panel.textContent += `${label}: ${value}\n`;
};

line('injected + evaluated', 'yes (needs no permission at all)');

__synapseModule = {
  id: 'synapse-ui-a',
  scopes: ['ui.render', 'page.dom'],

  async run(input, ctx) {
    const ui = ctx.api.ui;

    // --- 1. Draw. Both of these should appear alongside B's. -----------------------------------
    line('icon #1', ui.icon({ id: 'first', label: 'A', title: 'Script A — icon 1', onClick: () => line('click', 'A icon 1') }));
    line('icon #2', ui.icon({ id: 'second', label: 'A2', title: 'Script A — icon 2', onClick: () => line('click', 'A icon 2') }));

    // --- 3. Quota: the third icon must be refused (cap is 2 per script). ------------------------
    const third = ui.icon({ id: 'third', label: 'A3', onClick: () => {} });
    line('icon #3 (over quota)', third === false ? 'refused ✅' : `NOT refused ❌ (${third})`);

    line('toast', ui.toast({ id: 'hello', message: 'Script A is here', actionLabel: 'Ping', onAction: () => line('click', 'A toast action') }));

    // --- 4. Rate limit: a burst must start returning false rather than queueing forever. --------
    let refused = 0;
    for (let i = 0; i < 6; i++) {
      if (ui.toast({ id: `burst-${i}`, message: `burst ${i}` }) === false) refused++;
    }
    line('burst of 6 toasts', refused > 0 ? `${refused} refused ✅` : 'none refused ❌');

    // --- 2. The attack: try to remove B's surfaces using B's own ids. ---------------------------
    // B names its icon 'first' and its toast 'hello' — the SAME local ids this script used, which
    // is the point: if ids were global, one of these calls would hit B (or A would already have
    // clobbered B when drawing). Run this after a delay so B has certainly drawn by now.
    setTimeout(() => {
      ui.dismiss('icon', 'first');
      ui.dismiss('toast', 'hello');
      line('tried to dismiss B', "done — B's icon and toast must still be on screen ✅");
      line('own surfaces', 'A also removed its OWN first icon/toast, which is correct');
    }, 1500);
  },
};
