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

const synapseApi = {
  storage: {
    get: function (key) { return __synapseCall('storage', 'get', [key]); },
    set: function (key, value) { return __synapseCall('storage', 'set', [key, value]); },
    remove: function (key) { return __synapseCall('storage', 'remove', [key]); },
    keys: function () { return __synapseCall('storage', 'keys', []); },
  },
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
  globalThis.synapseApi = {
    storage: {
      get: __synapseWrongHandle,
      set: __synapseWrongHandle,
      remove: __synapseWrongHandle,
      keys: __synapseWrongHandle,
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
