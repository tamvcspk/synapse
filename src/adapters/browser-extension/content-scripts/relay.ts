import type { Module } from '../../../kernel/module';
import { isModuleActive } from '../module-registry/storage';
import { buildDomModuleApi } from './rpc-client';

export function registerDomModule(mod: Module): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.moduleId !== mod.id) return; // not for us

    (async () => {
      if (!(await isModuleActive(mod.id))) {
        sendResponse({ error: `Module "${mod.id}" is inactive` });
        return;
      }
      try {
        // A dom Module gets no Kernel Services (`ai`/`cache`/`bus` are background-only, and the
        // RPC-backed shims for them are gone with the Capability model) — `ctx.api` is the whole
        // contract it programs against now, same as an uploaded script's global.
        sendResponse(await mod.run(message.input, { services: {}, api: buildDomModuleApi(mod.id) }));
      } catch (err) {
        sendResponse({ error: err instanceof Error ? err.message : String(err) });
      }
    })();

    return true; // keep the message channel open for the async sendResponse
  });
}
