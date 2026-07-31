/**
 * Builds the plain-JS source registered via chrome.userScripts for an uploaded module.
 * The header/trailer below run in the same top-level scope as the uploaded code (chrome.userScripts
 * gives each registered script its own isolated USER_SCRIPT world per page, but not per-script
 * sub-isolation within that world) — intentionally minimal, no per-script sandboxing beyond what
 * chrome.userScripts itself provides, which is enough for a personal-use playground.
 *
 * Uploaded scripts declare themselves via `globalThis.__synapseModule = { id, needs, run }` since
 * there's no ESM import available inside USER_SCRIPT-world code (see docs/user-scripts.md).
 */
function header(moduleId: string): string {
  const idLiteral = JSON.stringify(moduleId);
  return `
const __SYNAPSE_MODULE_ID__ = ${idLiteral};
const __SYNAPSE_PENDING__ = new Map();

function __synapseCall(service, method, args) {
  return new Promise(function (resolve, reject) {
    const callId = crypto.randomUUID();
    __SYNAPSE_PENDING__.set(callId, { resolve: resolve, reject: reject });
    chrome.runtime.sendMessage({
      type: 'synapse:rpc',
      callId: callId,
      moduleId: __SYNAPSE_MODULE_ID__,
      service: service,
      method: method,
      args: args,
    });
  });
}

globalThis.synapse = {
  ai: { ask: function () { return __synapseCall('ai', 'ask', Array.prototype.slice.call(arguments)); } },
  cache: {
    get: function () { return __synapseCall('cache', 'get', Array.prototype.slice.call(arguments)); },
    set: function () { return __synapseCall('cache', 'set', Array.prototype.slice.call(arguments)); },
  },
  bus: {
    emit: function () { return __synapseCall('bus', 'emit', Array.prototype.slice.call(arguments)); },
    on: function () { return __synapseCall('bus', 'on', Array.prototype.slice.call(arguments)); },
  },
};

chrome.runtime.onMessage.addListener(function (message) {
  if (!message || message.type !== 'synapse:rpc-result') return;
  const pending = __SYNAPSE_PENDING__.get(message.callId);
  if (!pending) return;
  __SYNAPSE_PENDING__.delete(message.callId);
  if (message.error) pending.reject(new Error(message.error));
  else pending.resolve(message.result);
});
`.trim();
}

function trailer(): string {
  return `
(function () {
  const manifest = globalThis.__synapseModule;
  const hasRun = !!(manifest && typeof manifest.run === 'function');

  chrome.runtime.sendMessage({
    type: 'synapse:manifest-report',
    moduleId: __SYNAPSE_MODULE_ID__,
    id: manifest && manifest.id,
    needs: manifest && manifest.needs,
    hasRun: hasRun,
  });

  if (!hasRun) return;

  const needs = Array.isArray(manifest.needs) ? manifest.needs : [];
  const services = {};
  if (needs.indexOf('ai') !== -1) services.ai = globalThis.synapse.ai;
  if (needs.indexOf('cache') !== -1) services.cache = globalThis.synapse.cache;
  if (needs.indexOf('bus') !== -1) services.bus = globalThis.synapse.bus;

  function reportRunError(err) {
    chrome.runtime.sendMessage({
      type: 'synapse:manifest-report',
      moduleId: __SYNAPSE_MODULE_ID__,
      id: manifest.id,
      needs: manifest.needs,
      hasRun: hasRun,
      runError: err instanceof Error ? err.message : String(err),
    });
  }

  Promise.resolve()
    .then(function () { return manifest.run(undefined, { services: services }); })
    .catch(reportRunError);

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (!message || message.moduleId !== __SYNAPSE_MODULE_ID__ || message.type) return;
    Promise.resolve()
      .then(function () { return manifest.run(message.input, { services: services }); })
      .then(sendResponse)
      .catch(function (err) {
        reportRunError(err);
        sendResponse({ error: err instanceof Error ? err.message : String(err) });
      });
    return true;
  });
})();
`.trim();
}

export function buildShimSource(moduleId: string, userSource: string): string {
  return `${header(moduleId)}\n${userSource}\n${trailer()}`;
}
