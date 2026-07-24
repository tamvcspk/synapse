import { registerDomModule } from './relay';
import { buildDomModuleServices } from './rpc-client';
import { BUNDLED_MODULES } from '../module-registry/bundled-modules';
import { isModuleActive } from '../module-registry/storage';
import { installStorageToMainWorldRelay } from '../utils/main-world/storage-relay';
import { createMainWorldChannel } from '../utils/main-world/event-channel';
import { showFloatingWidget } from '../utils/floating-widget';
import { MOCK_CONFIG_CHANNEL_ID, MOCK_CONFIG_STORAGE_KEY } from '../background/modules/http-error-mocker/constants';
import { MAIN_WORLD_REPORT_CHANNEL_ID } from '../background/modules/network-sniffer/constants';

// Generic infra call (not a Module — see main-world-interceptor skill): forwards
// http-error-mocker's persisted MockConfig list into its MAIN-world interceptor whenever it's
// registered. Kept explicit rather than auto-discovered — only one feature needs this today.
installStorageToMainWorldRelay(MOCK_CONFIG_STORAGE_KEY, MOCK_CONFIG_CHANNEL_ID);

// network-sniffer's DOM/iframe detection (docs/ROADMAP.md #4) lives in a SEPARATE
// `all_frames: true` content_scripts entry (frame-media-observer.ts), not here — this file's entry
// stays top-frame-only (all_frames defaults to false) because chrome.tabs.sendMessage broadcasts to
// every frame when no frameId is given, and putting registerDomModule (below) in every iframe would
// let multiple frames race to answer the same trigger message.

// docs/ROADMAP.md #4.2 — In-Page Float Widget listener for network-sniffer's push
// (background/modules/network-sniffer/index.ts's notifyTabMediaFound). Registered here (not
// frame-media-observer.ts) for the same top-frame-only reason as registerDomModule above: showing
// one widget per page, not one per iframe. The count/message live entirely here rather than in the
// background — network-sniffer's push carries no payload, just "something new happened". The
// action button messages background to open the Dashboard (synapse:open-dashboard,
// background/index.ts) rather than a real `<a href="chrome-extension://...">` — Chrome blocks a
// page-context navigation to an extension URL unless it's listed in web_accessible_resources, and
// widening that just for this link would expose the whole Dashboard to any arbitrary website.
let mediaFoundCount = 0;
chrome.runtime.onMessage.addListener((message: { type?: string } | undefined) => {
  if (message?.type !== 'synapse:media-found') return;
  void (async () => {
    if (!(await isModuleActive('network-sniffer'))) return;
    mediaFoundCount += 1;
    showFloatingWidget({
      id: 'network-sniffer',
      message: mediaFoundCount === 1 ? 'Found 1 media item — click to view' : `Found ${mediaFoundCount} media items — click to view`,
      actionLabel: 'View',
      onAction: () => {
        chrome.runtime.sendMessage({ type: 'synapse:open-dashboard', moduleId: 'network-sniffer' }).catch(() => {});
      },
    });
  })();
});

// docs/ROADMAP.md #4.1 — relays network-sniffer's MAIN-world observer (main-world-payload.ts) to
// background purely for persistence into the Dashboard's detected-media list. Registered here
// (top-frame-only), matching where the MAIN-world script itself runs — registerMainWorldScript
// doesn't set `allFrames`, so it defaults to top-frame-only, same as http-error-mocker's. Separate
// from dom-media-observer.ts's OWN listener on this same channel (badge-anchoring correlation,
// no relay needed there — see that file) — two independent listeners on the same shared-window
// CustomEvent, one per purpose.
createMainWorldChannel<{ url: string }>(MAIN_WORLD_REPORT_CHANNEL_ID).onUpdate(({ url }) => {
  chrome.runtime.sendMessage({ event: 'network-sniffer', payload: { op: 'report-main-world-media', url } }).catch(() => {});
});

const domModules = BUNDLED_MODULES.filter((mod) => mod.needs?.includes('dom'));

for (const mod of domModules) {
  registerDomModule(mod);
}

// 'reader-mode-converter' now fetches every image on the page (docs/ROADMAP.md #1's rebuild as a
// Composite Module) — no longer a cheap smoke test, so it's excluded from the automatic per-page
// run below (kept explicit rather than a generic opt-out field, same "only one thing needs this"
// style as the mock-config relay above).
const AUTORUN_EXCLUDED = new Set(['reader-mode-converter']);

// One-off smoke-test invocation per active 'dom' Module, so loading the extension gives
// immediate visual confirmation that the Kernel foundation + auto-discovery wire up correctly.
for (const mod of domModules.filter((mod) => !AUTORUN_EXCLUDED.has(mod.id))) {
  void (async () => {
    if (!(await isModuleActive(mod.id))) return;
    try {
      await mod.run(undefined, { services: buildDomModuleServices(mod.id, mod.needs) });
    } catch (err) {
      console.error(`Synapse: module "${mod.id}" failed on auto-run`, err);
    }
  })();
}
