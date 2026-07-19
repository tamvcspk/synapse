import type { Module } from '../../../kernel/module';

export function registerDomModule(mod: Module): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.moduleId !== mod.id) return; // not for us
    mod.run(message.input, { services: {} }).then(sendResponse);
    return true;
  });
}
