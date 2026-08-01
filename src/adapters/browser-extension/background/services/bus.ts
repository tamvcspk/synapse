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
  // docs/ROADMAP.md §11.5 — the write half of CollectionCommand used to be pure fire-and-forget:
  // a rejected MockConfig (e.g. action:'block' + mechanism:'main-world', which validateMockConfig
  // hard-rejects) threw inside the Module's run(), got caught by Scheduler.registerOnBus, logged to
  // the SERVICE WORKER's own console, and the sender (the Dashboard page, a completely different
  // context) never learned anything went wrong — its onSave() had already navigated away by then.
  // A handler that returns a Promise now gets awaited and its outcome threaded back through
  // sendResponse — `return true` keeps the message channel open until that resolves (MV3's
  // documented pattern for an async sendResponse; without it Chrome closes the channel synchronously
  // and a later sendResponse call is silently dropped, per docs/LESSONS.md's messaging section). A
  // handler that returns void/undefined behaves exactly as before — every other bus.on() caller
  // (network-sniffer's/iframe-unsandbox's startup 'sync', report-* ops) is unaffected.
  on(event, handler) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.event !== event) return undefined;
      const result = handler(message.payload);
      if (!(result instanceof Promise)) return undefined;
      result.then(
        (value) => sendResponse({ ok: true, value }),
        (err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
      return true;
    });
  },
};
