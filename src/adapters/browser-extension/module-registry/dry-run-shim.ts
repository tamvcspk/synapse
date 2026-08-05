import { header, normalizerSource } from './user-script-shim';

/**
 * "Run once on this tab" (docs/ROADMAP.md §12.5) — the throwaway counterpart of
 * `user-script-shim.ts`'s `buildShimSource`, injected via `chrome.userScripts.execute()` instead of
 * `chrome.userScripts.register()`. Reuses `header()` verbatim (same RPC transport, `ctx.api.ui`, and
 * subscription setup a saved script gets — a dry run must call `ctx.api` through the IDENTICAL path,
 * or it wouldn't be testing what Save would actually register) and `normalizerSource()` (the same
 * run/steps → one shape normalization). The two differences are entirely in what happens AFTER the
 * user's own source runs:
 *
 * 1. **`console.log`/`warn`/`error` are shadowed and relayed** as `synapse:dry-run-log` (kernel/rpc.ts)
 *    — a `var console = {...}` inside this script's OWN IIFE, so it can never intercept a
 *    concurrently-registered script's console calls in the same USER_SCRIPT world (each script's IIFE
 *    has its own function-scoped binding, the same isolation `__synapseUi`/`__synapseCall` already
 *    rely on for identity).
 * 2. **The pipeline's outcome is reported as `synapse:dry-run-result`, never `synapse:manifest-report`**
 *    — a throwaway run of possibly-unsaved edits must never be persisted via `setManifestReport`
 *    (rpc-handler.ts), or it would overwrite what the popup/Studio sidebar show for the script's last
 *    CONFIRMED (saved-and-registered) run with a result that may not even correspond to any saved code.
 */

/** `window.console`, not the bare `console` global — the shadowing `var console` declared below is
 * hoisted to the top of this IIFE's scope, so any reference to the bare identifier `console` anywhere
 * in this scope resolves to that (TDZ-safe only because `var` has none, unlike `const`/`let`) local
 * binding, not the real one. Going through `window.` sidesteps the shadow entirely. */
function consoleCaptureSource(runId: string): string {
  const runIdLiteral = JSON.stringify(runId);
  return `
var __synapseRealConsole = window.console;
function __synapseDryRunLog(level, args) {
  var text = Array.prototype.map.call(args, function (a) {
    if (typeof a === 'string') return a;
    // An Error's own enumerable properties do NOT include message/stack (V8 puts both on the
    // prototype chain as non-enumerable) — JSON.stringify(someError) is '{}', which is exactly
    // what silently swallowed the real reason behind a failed ctx.api.* call in every dry run
    // before this: \`console.error('x failed', err)\` relayed as "x failed {}". Checked here rather
    // than fixed at each call site, since \`err\` reaching a bare console.error is the normal case,
    // not a bug at the call site.
    if (a instanceof Error) return a.name + ': ' + a.message;
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }).join(' ');
  chrome.runtime.sendMessage({ type: 'synapse:dry-run-log', runId: ${runIdLiteral}, level: level, text: text }).catch(function () {});
}
var console = {
  log: function () { __synapseRealConsole.log.apply(__synapseRealConsole, arguments); __synapseDryRunLog('log', arguments); },
  info: function () { __synapseRealConsole.info.apply(__synapseRealConsole, arguments); __synapseDryRunLog('log', arguments); },
  debug: function () { __synapseRealConsole.debug.apply(__synapseRealConsole, arguments); __synapseDryRunLog('log', arguments); },
  warn: function () { __synapseRealConsole.warn.apply(__synapseRealConsole, arguments); __synapseDryRunLog('warn', arguments); },
  error: function () { __synapseRealConsole.error.apply(__synapseRealConsole, arguments); __synapseDryRunLog('error', arguments); },
};
`.trim();
}

/**
 * Mirrors `user-script-shim.ts`'s own `trailer()`/`runPipeline` control flow (normalize → query
 * subState → run steps in order, no rollback) but sends every outcome as `synapse:dry-run-result`
 * instead of `synapse:manifest-report`, and never calls `chrome.runtime.onMessage.addListener` for a
 * second invocation the way the production trailer does — a Dry Run is inherently one-shot, injected
 * fresh on every click, so there is nothing later to dispatch to.
 */
function dryRunTrailer(runId: string): string {
  const runIdLiteral = JSON.stringify(runId);
  return `
const manifest = globalThis.__synapseModule;
delete globalThis.__synapseModule;

${normalizerSource()}

const __synapseNormalized = normalizeManifestSteps(manifest);

function __synapseSendDryRunResult(payload) {
  chrome.runtime.sendMessage(Object.assign({ type: 'synapse:dry-run-result', runId: ${runIdLiteral} }, payload)).catch(function () {});
}

if (!__synapseNormalized.valid) {
  __synapseSendDryRunResult({ ok: false, error: __synapseNormalized.reason });
} else {
  chrome.runtime.sendMessage({ type: 'synapse:sub-state-query', moduleId: __SYNAPSE_MODULE_ID__ })
    .then(function (response) {
      var subState = (response && response.subState) || {};
      var value;
      var results = [];
      var chain = Promise.resolve();
      __synapseNormalized.steps.forEach(function (step) {
        chain = chain.then(function () {
          if (subState[step.id] === false) {
            results.push({ id: step.id, ok: true, durationMs: 0, skipped: true });
            return;
          }
          var startedAt = Date.now();
          return Promise.resolve()
            .then(function () { return step.run(value, { api: synapseApi }); })
            .then(function (out) {
              value = out;
              results.push({ id: step.id, ok: true, durationMs: Date.now() - startedAt });
            })
            .catch(function (err) {
              results.push({
                id: step.id,
                ok: false,
                durationMs: Date.now() - startedAt,
                error: err instanceof Error ? err.message : String(err),
              });
            });
        });
      });
      return chain.then(function () {
        var firstFailure = results.filter(function (r) { return r.ok === false; })[0];
        __synapseSendDryRunResult({ ok: !firstFailure, error: firstFailure ? firstFailure.error : undefined, steps: results });
      });
    })
    .catch(function (err) {
      __synapseSendDryRunResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
}
`.trim();
}

export function buildDryRunShimSource(moduleId: string, userSource: string, runId: string): string {
  return `(function () {\n${header(moduleId)}\n${consoleCaptureSource(runId)}\n${userSource}\n${dryRunTrailer(runId)}\n})();`;
}
