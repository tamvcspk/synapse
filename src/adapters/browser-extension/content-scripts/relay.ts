import type { Module } from '../../../kernel/module';
import { isModuleActive } from '../module-registry/storage';

export function registerDomModule(mod: Module): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.moduleId !== mod.id) return; // not for us

    (async () => {
      if (!(await isModuleActive(mod.id))) {
        sendResponse({ error: `Module "${mod.id}" is inactive` });
        return;
      }
      try {
        sendResponse(await mod.run(message.input, { services: {} }));
      } catch (err) {
        sendResponse({ error: err instanceof Error ? err.message : String(err) });
      }
    })();

    return true; // keep the message channel open for the async sendResponse
  });
}
