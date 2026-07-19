import type { BusService } from '../../../../kernel/module';

/**
 * chrome.runtime-backed BusService (docs/design.md §3.C), matching the reference implementation
 * documented in the kernel-bootstrap skill. Wired into the ServiceInjector in background/index.ts
 * once a Module actually declares `bus` — http-error-mocker is the first.
 */
export const chromeRuntimeBus: BusService = {
  emit(event, payload) {
    chrome.runtime.sendMessage({ event, payload });
  },
  on(event, handler) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.event === event) handler(message.payload);
    });
  },
};
