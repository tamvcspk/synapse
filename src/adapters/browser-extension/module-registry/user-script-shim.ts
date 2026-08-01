import {
  KEY_SEPARATOR,
  SURFACE_QUOTA,
  TOAST_BURST,
  TOAST_REFILL_MS,
} from '../../../shared/ui/surface-policy';

/**
 * Builds the plain-JS source registered via chrome.userScripts for an uploaded module.
 *
 * **Everything is wrapped in one IIFE, including the user's own source.** chrome.userScripts gives
 * each *page* its own USER_SCRIPT world, but every registered script shares that one world — there
 * is no per-script sub-isolation. At top level, `const __SYNAPSE_MODULE_ID__ = …` therefore lands
 * in the world's shared global lexical environment, and the second script to be evaluated on a page
 * dies with `SyntaxError: Identifier '__SYNAPSE_MODULE_ID__' has already been declared` — i.e. the
 * platform could only ever run ONE user script (docs/ROADMAP.md §11.9, the question Phase 2 opened
 * with). Inside a function scope the collision cannot happen at all, and the user's own top-level
 * `const`/`let`/`function` declarations stop leaking into the shared world as a bonus.
 *
 * The IIFE is deliberately synchronous, not `async`: with an `await` in it, one script's snapshot
 * of `globalThis.__synapseModule` could be taken after a different script had already overwritten
 * it. Scripts wanting top-level `await` use an async IIFE of their own inside `run()`.
 *
 * The same "one shared world" fact is why the API is passed as `ctx.api` and is NOT published as a
 * global — see the comment on the guard stub below. That is a correction to §11.3's original plan
 * ("shim: `globalThis.synapseApi`"), which was written before multi-script support existed: a
 * global has exactly one binding per world, so it cannot carry per-script identity.
 *
 * Uploaded scripts declare themselves via `globalThis.__synapseModule = { id, scopes, run }` since
 * there's no ESM import available inside USER_SCRIPT-world code (see docs/user-scripts.md).
 */

/**
 * `synapseApi.ui` for the USER_SCRIPT world — the one namespace that is NOT sent to the background.
 *
 * docs/ROADMAP.md §11.0 settled that the UI engine runs in the same world as the code declaring the
 * UI, because an engine behind a message boundary cannot accept an `onClick` closure. A user script
 * cannot import `utils/ui-compositor.ts` (that module lives in the extension's ISOLATED bundle and
 * there is no ESM in this world), so the DOM half is written out again here.
 *
 * **That duplication is deliberate and bounded, and it is bounded on purpose:**
 * - Every *value* is interpolated from `shared/ui/surface-policy.ts` below, so the quota, the rate
 *   limit and the key separator cannot drift — only the DOM calls are written twice.
 * - `user-script-shim.test.ts` asserts this source exposes exactly the `ui` methods `API_METHODS`
 *   lists as `transport: 'in-world'`, so adding one to the catalog and forgetting it here is a
 *   failing test rather than a method that silently does not exist for uploaded scripts.
 * - The *styling* is not duplicated: the content script owns the constructed stylesheet, and this
 *   code only creates elements carrying the same class names. If it wins the race and builds the
 *   host first, it deliberately leaves `data-styled` unset so the content script fills it in.
 */
function uiSource(): string {
  return `
const __SYNAPSE_UI_ROOT_ID = 'synapse-ui-root';

function __synapseUiRoot() {
  let host = document.getElementById(__SYNAPSE_UI_ROOT_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = __SYNAPSE_UI_ROOT_ID;
    document.documentElement.appendChild(host);
    const all = document.querySelectorAll('#' + __SYNAPSE_UI_ROOT_ID);
    if (all.length > 1 && all[0] !== host) { host.remove(); host = all[0]; }
  }
  const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
  // Styling is the content script's job (it holds the stylesheet). Only the structure is ensured
  // here, in case a user script draws before the content script has run.
  for (const zone of ['icons', 'toasts', 'badges']) {
    if (!root.querySelector('.syn-zone[data-zone="' + zone + '"]')) {
      const el = document.createElement('div');
      el.className = 'syn-zone';
      el.setAttribute('data-zone', zone);
      root.appendChild(el);
    }
  }
  return root;
}

function __synapseUiHidden(ownerId) {
  const raw = document.getElementById(__SYNAPSE_UI_ROOT_ID);
  const list = raw ? (raw.getAttribute('data-hidden-owners') || '').split(' ') : [];
  return list.indexOf(ownerId) !== -1;
}

function __synapseUiOwner(zone, ownerId) {
  const parent = __synapseUiRoot().querySelector('.syn-zone[data-zone="' + zone + '"]');
  const existing = parent.querySelector(':scope > [data-owner="' + CSS.escape(ownerId) + '"]');
  if (existing) return existing;
  const el = document.createElement('div');
  el.className = 'syn-owner';
  el.setAttribute('data-owner', ownerId);
  // Born hidden if the owner is currently muted — the valve is a display state, not a refusal, so
  // drawing while muted must produce a surface that simply is not shown yet.
  if (__synapseUiHidden(ownerId)) el.setAttribute('data-hidden', '');
  // Sorted insertion, NOT append: order must not depend on which world drew first.
  const siblings = Array.prototype.map.call(parent.children, function (c) { return c.getAttribute('data-owner') || ''; });
  let index = siblings.length;
  for (let i = 0; i < siblings.length; i++) { if (siblings[i] > ownerId) { index = i; break; } }
  parent.insertBefore(el, parent.children[index] || null);
  return el;
}

const __synapseUi = (function (ownerId) {
  const ZONE = { icon: 'icons', toast: 'toasts', badge: 'badges' };
  const QUOTA = { icon: ${SURFACE_QUOTA.icon}, toast: ${SURFACE_QUOTA.toast}, badge: ${SURFACE_QUOTA.badge} };
  const SEP = ${JSON.stringify(KEY_SEPARATOR)};
  let tokens = ${TOAST_BURST};
  let tokensAt = Date.now();
  const badges = new Map();
  let raf = null;

  function key(id) { return ownerId + SEP + id; }
  function container(kind) {
    const root = document.getElementById(__SYNAPSE_UI_ROOT_ID);
    const shadow = root && root.shadowRoot;
    return shadow ? shadow.querySelector('.syn-zone[data-zone="' + ZONE[kind] + '"] > [data-owner="' + CSS.escape(ownerId) + '"]') : null;
  }
  function existing(kind, id) {
    const c = container(kind);
    return c ? c.querySelector('[data-key="' + CSS.escape(key(id)) + '"]') : null;
  }
  function acquire(kind, id, build) {
    const found = existing(kind, id);
    if (found) return found;
    const c = container(kind);
    if (c && c.querySelectorAll('[data-key]').length >= QUOTA[kind]) return null;
    const el = build();
    el.setAttribute('data-key', key(id));
    __synapseUiOwner(ZONE[kind], ownerId).appendChild(el);
    return el;
  }
  function track() {
    badges.forEach(function (b, k) {
      if (!b.target.isConnected || !b.el.isConnected) { b.el.remove(); badges.delete(k); return; }
      const rect = b.target.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      b.el.style.display = visible ? '' : 'none';
      if (visible) { b.el.style.top = (rect.top + 6) + 'px'; b.el.style.left = (rect.left + 6) + 'px'; }
    });
    raf = badges.size > 0 ? requestAnimationFrame(track) : null;
  }

  return {
    toast: function (options) {
      const found = existing('toast', options.id);
      if (!found) {
        const now = Date.now();
        tokens = Math.min(${TOAST_BURST}, tokens + Math.max(0, now - tokensAt) / ${TOAST_REFILL_MS});
        tokensAt = now;
        if (tokens < 1) return false;
        tokens -= 1;
      }
      const card = found || acquire('toast', options.id, function () {
        const el = document.createElement('div');
        el.className = 'syn-toast';
        const message = document.createElement('span');
        message.className = 'syn-toast-message';
        el.appendChild(message);
        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'syn-toast-action';
        el.appendChild(action);
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'syn-toast-close';
        close.textContent = '\\u00d7';
        close.onclick = function () { el.remove(); };
        el.appendChild(close);
        return el;
      });
      if (!card) return false;
      card.querySelector('.syn-toast-message').textContent = options.message;
      const action = card.querySelector('.syn-toast-action');
      if (options.onAction) {
        action.textContent = options.actionLabel || 'View';
        action.style.display = '';
        action.onclick = options.onAction;
      } else {
        action.style.display = 'none';
        action.onclick = null;
      }
      return true;
    },
    icon: function (options) {
      const el = acquire('icon', options.id, function () {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'syn-icon';
        return b;
      });
      if (!el) return false;
      el.textContent = options.label;
      if (options.title !== undefined) el.title = options.title;
      el.onclick = options.onClick;
      return true;
    },
    badge: function (options) {
      const el = acquire('badge', options.id, function () {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'syn-badge';
        return b;
      });
      if (!el) return false;
      el.textContent = options.label;
      el.title = options.title || '';
      el.onclick = options.onClick;
      badges.set(key(options.id), { el: el, target: options.target });
      if (raf === null) raf = requestAnimationFrame(track);
      return true;
    },
    dismiss: function (kind, id) {
      const el = existing(kind, id);
      if (el) el.remove();
      badges.delete(key(id));
    },
    clear: function () {
      ['icons', 'toasts', 'badges'].forEach(function (zone) {
        const root = document.getElementById(__SYNAPSE_UI_ROOT_ID);
        const shadow = root && root.shadowRoot;
        const c = shadow && shadow.querySelector('.syn-zone[data-zone="' + zone + '"] > [data-owner="' + CSS.escape(ownerId) + '"]');
        if (c) c.remove();
      });
      badges.forEach(function (_b, k) { if (k.indexOf(ownerId + SEP) === 0) badges.delete(k); });
    },
  };
})(__SYNAPSE_MODULE_ID__);
`.trim();
}

/** Injected before the user's code: the RPC transport plus the `synapseApi` facade. Must stay in
 * sync with `kernel/synapse-api.ts` (the interface) and `kernel/scopes.ts`'s `API_METHODS` (which
 * is what the background will actually accept) — a method here that isn't in the catalog is
 * rejected at the boundary, and one in the catalog but missing here is unreachable for scripts. */
function header(moduleId: string): string {
  const idLiteral = JSON.stringify(moduleId);
  return `
const __SYNAPSE_MODULE_ID__ = ${idLiteral};

// The reply comes back as sendMessage's own resolved value, because rpc-handler.ts answers with
// sendResponse(). It is NOT re-broadcast as an inbound message — an earlier version of this shim
// waited for a 'synapse:rpc-result' onMessage that nothing ever sends, so every single call hung
// forever with no error anywhere. Awaiting the promise is the whole fix; keep it that way.
function __synapseCall(namespace, method, args) {
  return chrome.runtime.sendMessage({
    type: 'synapse:rpc',
    callId: crypto.randomUUID(),
    moduleId: __SYNAPSE_MODULE_ID__,
    namespace: namespace,
    method: method,
    args: args,
  }).then(function (response) {
    if (!response) {
      throw new Error('Synapse: no response from the extension background (was it reloaded?)');
    }
    if (response.error) throw new Error(response.error);
    return response.result;
  });
}

${uiSource()}

const synapseApi = {
  storage: {
    get: function (key) { return __synapseCall('storage', 'get', [key]); },
    set: function (key, value) { return __synapseCall('storage', 'set', [key, value]); },
    remove: function (key) { return __synapseCall('storage', 'remove', [key]); },
    keys: function () { return __synapseCall('storage', 'keys', []); },
  },
  ui: __synapseUi,
};

// This object is per-script (it closes over __SYNAPSE_MODULE_ID__) and is handed to run() as
// ctx.api. It is deliberately NOT published as globalThis.synapseApi: one shared world means one
// global binding for every script, so whichever script was evaluated last would own it and every
// other script's calls would go out under THAT script's moduleId and grants. A loud stub takes the
// name instead, so a script written against the old global fails with the reason rather than
// silently acting as its neighbour.
if (!globalThis.synapseApi) {
  const __synapseWrongHandle = function () {
    return Promise.reject(new Error(
      'synapseApi is not a global. Several user scripts share one USER_SCRIPT world, so a global ' +
      'cannot identify which script is calling — use the ctx.api argument passed to your ' +
      'run(input, ctx).'
    ));
  };
  // ui's methods are synchronous, so the guard has to THROW rather than return a rejected promise —
  // a script testing the return value of synapseApi.ui.toast(...) in an if would otherwise get a
  // truthy Promise and carry on believing it had drawn something.
  const __synapseWrongHandleSync = function () {
    throw new Error(
      'synapseApi is not a global. Several user scripts share one USER_SCRIPT world, so a global ' +
      'cannot identify which script is calling — use the ctx.api argument passed to your ' +
      'run(input, ctx).'
    );
  };
  globalThis.synapseApi = {
    storage: {
      get: __synapseWrongHandle,
      set: __synapseWrongHandle,
      remove: __synapseWrongHandle,
      keys: __synapseWrongHandle,
    },
    ui: {
      toast: __synapseWrongHandleSync,
      icon: __synapseWrongHandleSync,
      badge: __synapseWrongHandleSync,
      dismiss: __synapseWrongHandleSync,
      clear: __synapseWrongHandleSync,
    },
  };
}

// Cleared before the user's code runs so a script that never assigns one cannot inherit the
// PREVIOUS script's manifest out of the shared world and get registered twice under two ids.
delete globalThis.__synapseModule;
`.trim();
}

function trailer(): string {
  return `
const manifest = globalThis.__synapseModule;
delete globalThis.__synapseModule;
const hasRun = !!(manifest && typeof manifest.run === 'function');

chrome.runtime.sendMessage({
  type: 'synapse:manifest-report',
  moduleId: __SYNAPSE_MODULE_ID__,
  id: manifest && manifest.id,
  scopes: manifest && manifest.scopes,
  hasRun: hasRun,
});

if (!hasRun) return;

function reportRunError(err) {
  chrome.runtime.sendMessage({
    type: 'synapse:manifest-report',
    moduleId: __SYNAPSE_MODULE_ID__,
    id: manifest.id,
    scopes: manifest.scopes,
    hasRun: hasRun,
    runError: err instanceof Error ? err.message : String(err),
  });
}

Promise.resolve()
  .then(function () { return manifest.run(undefined, { api: synapseApi }); })
  .catch(reportRunError);

// UNVERIFIED, and suspected dead: this is the "call an uploaded module's run() with an input"
// dispatcher, and nothing in the extension sends to it today. Chrome routes user-script→extension
// messages to a dedicated event (chrome.runtime.onUserScriptMessage), and there is no documented
// path in the other direction, so this listener may never fire at all. Left in place rather than
// deleted because removing it would quietly drop a documented-but-unused capability; if a caller is
// ever added, verify end-to-end on real Chrome FIRST (docs/ROADMAP.md Open Points).
chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
  if (!message || message.moduleId !== __SYNAPSE_MODULE_ID__ || message.type) return;
  Promise.resolve()
    .then(function () { return manifest.run(message.input, { api: synapseApi }); })
    .then(sendResponse)
    .catch(function (err) {
      reportRunError(err);
      sendResponse({ error: err instanceof Error ? err.message : String(err) });
    });
  return true;
});
`.trim();
}

export function buildShimSource(moduleId: string, userSource: string): string {
  // The `return` in the trailer's `if (!hasRun)` is what requires a function wrapper rather than a
  // bare block — and the wrapper is what makes two user scripts able to coexist at all.
  return `(function () {\n${header(moduleId)}\n${userSource}\n${trailer()}\n})();`;
}
