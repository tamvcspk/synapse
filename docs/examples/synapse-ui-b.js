// Synapse Phase 3 verification — script B of 2 (docs/ROADMAP.md §11.4).
// Upload alongside synapse-ui-a.js. See that file's header for what the pair proves.
//
// B uses the SAME local ids as A ('first' for its icon, 'hello' for its toast). That collision is
// the whole point: with the old caller-supplied-id widget host the two scripts would have fought
// over one entry. Here each id is namespaced to its owner by the platform, so both survive — and
// A's attempt to dismiss 'first'/'hello' (which it makes 1.5s in) must not touch these.
//
// B also anchors a badge to a real element on the page, which is the third surface kind and the
// only one that tracks something the page owns.

const panel = document.createElement('div');
// Anchored to the BOTTOM-left, not a fixed `top`: A's panel grows downward as it appends results,
// and a fixed offset here let B cover A's last lines (both are plain page DOM at the same z-index,
// so the one appended later simply wins). Bottom-left also stays clear of the toast stack, which
// the compositor owns bottom-right.
panel.style.cssText =
  'position:fixed;left:12px;bottom:12px;z-index:2147483646;max-width:340px;padding:8px 10px;' +
  'background:#c50;color:#fff;font:12px/1.5 system-ui,sans-serif;border-radius:6px;white-space:pre-wrap';
panel.textContent = 'Synapse UI test — B\n';
document.documentElement.appendChild(panel);

const line = (label, value) => {
  panel.textContent += `${label}: ${value}\n`;
};

line('injected + evaluated', 'yes (needs no permission at all)');

globalThis.__synapseModule = {
  id: 'synapse-ui-b',
  scopes: ['ui.render', 'page.dom'],

  async run(input, ctx) {
    const ui = ctx.api.ui;

    line('icon (id "first")', ui.icon({ id: 'first', label: 'B', title: 'Script B', onClick: () => line('click', 'B icon') }));
    line('toast (id "hello")', ui.toast({ id: 'hello', message: 'Script B is here too' }));

    // Badge anchor. `#badge-target` is the element strict-csp-page.cjs provides for exactly this;
    // everywhere else, fall back to the first sizeable element so the fixture still works on any
    // site. The fallback used to be the only path and it silently picked the page's `<h1>`:
    // `querySelectorAll('img, video, h1, p')` returns **document order**, not the order the
    // selectors are written in, so listing `img` first bought nothing.
    const target =
      document.querySelector('#badge-target') ??
      [...document.querySelectorAll('img, video, h1, p')].find((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 80 && rect.height > 20;
      });
    if (target) {
      line('badge', ui.badge({ id: 'anchor', target, label: '★', title: 'Script B badge', onClick: () => line('click', 'B badge') }));
      line('badge anchored to', target.tagName.toLowerCase());
    } else {
      line('badge', 'skipped — no suitably sized element on this page');
    }

    // After A has run its dismiss attempt, confirm from B's side that B is still on screen.
    setTimeout(() => {
      line('after A tried to dismiss B', 'if the B icon/toast are still visible, ownership held ✅');
    }, 2500);
  },
};
