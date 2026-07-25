import { Kernel } from '../../../kernel';
import type { Module } from '../../../kernel/module';
import { ServiceInjector } from '../../../kernel/service-injector';
import { resolveWorkflowSteps, type Workflow } from '../../../kernel/workflow';
import { createCompositeModule } from '../../../kernel/composite-module';
import { registerRpcHandler } from '../module-registry/rpc-handler';
import { BACKGROUND_MODULES } from '../module-registry/background-modules';
import { setUserScriptsPermissionGranted } from '../module-registry/storage';
import { DASHBOARD_PATH } from '../ui/dashboard/dashboard-path';
import { SIDE_PANEL_PATH } from '../ui/side-panel/side-panel-path';
import { chromeRuntimeBus } from './services/bus';
import { chromeStorageCache } from './services/cache';
// import a concrete ai factory once a Module actually declares it — see kernel-bootstrap skill

const injector = new ServiceInjector({
  // ai: () => chromeAiAdapter,
  cache: () => chromeStorageCache,
  bus: () => chromeRuntimeBus,
});
const kernel = new Kernel(injector);

registerRpcHandler(injector);

// Registers every background/modules/*/index.ts Module onto the Bus (needs: ['bus']) or runs it
// once (pipeline). A bus-only Module never gets an initial call from kernel.run() itself — it's
// only registered as a listener — so http-error-mocker also needs an explicit startup 'sync' so
// configs left active from a previous session resume being registered after a service-worker
// restart. Awaited (not fire-and-forget) so the 'sync' emit below is guaranteed to run after bus
// registration has actually happened, rather than relying on Kernel.run's internal ordering.
void kernel
  .run(BACKGROUND_MODULES, undefined, (failure) => {
    console.error(`Synapse: background module "${failure.moduleId}" failed`, failure.error);
  })
  .then(() => {
    chromeRuntimeBus.emit('http-error-mocker', { op: 'sync' });
    // network-sniffer (docs/ROADMAP.md #4) needs the same startup nudge to re-install its
    // chrome.webRequest listener after a service-worker restart, if the module is active.
    chromeRuntimeBus.emit('network-sniffer', { op: 'sync' });
    // iframe-unsandbox (docs/ROADMAP.md #4 Part C) needs the same nudge to re-sync its DNR rule.
    chromeRuntimeBus.emit('iframe-unsandbox', { op: 'sync' });
  });

// docs/ROADMAP.md #4.2 — generic relay so any content-script UI (float-widget on-page action, not
// just network-sniffer) can open the Dashboard without chrome.tabs (content scripts don't have it)
// and without listing the Dashboard in web_accessible_resources (a direct page-context
// `<a href="chrome-extension://...">` click is blocked by Chrome otherwise — see
// content-scripts/index.ts's comment). Generic on purpose: only `moduleId` is module-specific, the
// relay itself doesn't know or care which Module sent it.
chrome.runtime.onMessage.addListener((message: { type?: string; moduleId?: string } | undefined) => {
  if (message?.type !== 'synapse:open-dashboard' || !message.moduleId) return;
  void chrome.tabs.create({ url: `${chrome.runtime.getURL(DASHBOARD_PATH)}?moduleId=${encodeURIComponent(message.moduleId)}` });
});

// docs/ROADMAP.md §6.2 — network-sniffer's floating icon (utils/floating-widget.ts's
// showFloatingIcon, wired up in content-scripts/index.ts) can't call chrome.sidePanel itself
// (content scripts don't have that API), so it messages background to open it for its own tab.
// docs/ROADMAP.md §6.7 — `chrome.sidePanel.open()` must be called SYNCHRONOUSLY within this
// listener, with nothing awaited first — the user-gesture "activation" this relies on (carried
// across the chrome.runtime.sendMessage round trip from the content script's click handler)
// expires after even one microtask tick. §6.6 previously added an `await
// chrome.sidePanel.setOptions(...)` right before this call to fix a DIFFERENT bug ("No active side
// panel for tabId") — that awaited call is exactly what broke the gesture and produced "may only
// be called in response to a user gesture" instead. The original "No active side panel" bug's real
// cause was syncSidePanelForTab (below) calling setOptions on every tab unconditionally — already
// fixed by narrowing it to only ever touch a tab it has itself disabled — so no setOptions call is
// needed here anymore at all.
chrome.runtime.onMessage.addListener((message: { type?: string } | undefined, sender) => {
  if (message?.type !== 'synapse:open-network-sniffer-panel' || !sender.tab?.id) return;
  chrome.sidePanel.open({ tabId: sender.tab.id }).catch((err) => {
    console.error('Synapse: failed to open network-sniffer Side Panel', err);
  });
});

// docs/ROADMAP.md §6.5 — the Side Panel makes no sense while a Synapse extension page itself is
// the active tab (e.g. Dashboard, opened from the Side Panel's own "Settings" button) — per-tab
// disable so Chrome hides/collapses the panel automatically when such a tab becomes active,
// instead of leaving network-sniffer's panel showing over the Dashboard. Only Dashboard is handled
// for now (the only case reported so far); extend this list if Merge/Review need the same.
const SIDE_PANEL_DISABLED_URL_PREFIXES = [chrome.runtime.getURL(DASHBOARD_PATH)];

// docs/ROADMAP.md §6.6 — only ever calls chrome.sidePanel.setOptions for a tab THIS module itself
// previously disabled (re-enabling it once its tab navigates away from Dashboard), never for the
// many ordinary tabs it hasn't touched — narrowed after the "No active side panel for tabId" bug,
// to minimize how much of chrome.sidePanel's per-tab state this file reaches into.
const disabledSidePanelTabs = new Set<number>();

async function syncSidePanelForTab(tabId: number, url: string | undefined): Promise<void> {
  const shouldDisable = !!url && SIDE_PANEL_DISABLED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
  if (shouldDisable === disabledSidePanelTabs.has(tabId)) return; // already in the right state
  try {
    if (shouldDisable) {
      await chrome.sidePanel.setOptions({ tabId, enabled: false });
      disabledSidePanelTabs.add(tabId);
    } else {
      await chrome.sidePanel.setOptions({ tabId, path: SIDE_PANEL_PATH, enabled: true });
      disabledSidePanelTabs.delete(tabId);
    }
  } catch {
    // Tab may have closed between the event firing and this call — best-effort.
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) void syncSidePanelForTab(tabId, changeInfo.url);
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs
    .get(tabId)
    .then((tab) => syncSidePanelForTab(tabId, tab.url))
    .catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => disabledSidePanelTabs.delete(tabId));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  kernel.run(/* resolve modules for message.workflowId */ [], message.input, (failure) => {
    console.error(`Synapse: module "${failure.moduleId}" failed`, failure.error);
  }).then(sendResponse);
  return true; // keep the message channel open for the async sendResponse
});

// Lets uploaded modules (chrome.userScripts, USER_SCRIPT world) reach the background via
// chrome.runtime.sendMessage — throws if the user hasn't enabled "Allow User Scripts" for this
// extension in chrome://extensions, so this must not crash the service worker on failure. The
// result is persisted (not just logged) so the popup can surface it — see storage.ts and
// popup/main.ts. When "Allow User Scripts" has never been granted, `chrome.userScripts` itself is
// `undefined` (not just a rejecting call) — a bare `.then()/.catch()` chain doesn't cover that,
// since the property access throws synchronously before either ever attaches. An uncaught throw
// during a service worker's top-level evaluation fails the *entire* registration (Chrome status
// code 15), discarding every listener in this file — hence the outer try/catch.
try {
  chrome.userScripts.configureWorld({ messaging: true })
    .then(() => setUserScriptsPermissionGranted(true))
    .catch((err) => {
      console.warn('Synapse: chrome.userScripts.configureWorld failed — enable "Allow User Scripts" for this extension in chrome://extensions to use uploaded modules.', err);
      void setUserScriptsPermissionGranted(false);
    });
} catch (err) {
  console.warn('Synapse: chrome.userScripts is unavailable — enable "Allow User Scripts" for this extension in chrome://extensions to use uploaded modules.', err);
  void setUserScriptsPermissionGranted(false);
}

// Smoke-test for Workflow (kernel/workflow.ts): 'append-a' sorts before 'append-b' alphabetically,
// but the Workflow explicitly orders b-then-a — proving execution order comes from Workflow.steps,
// never from module-discovery/glob iteration order (see bundled-modules.ts).
const demoModules: Module<string, string>[] = [
  { id: 'append-a', needs: [], async run(input) { return `${input} A`; } },
  { id: 'append-b', needs: [], async run(input) { return `${input} B`; } },
];
const demoWorkflow: Workflow = { id: 'demo-chain', steps: ['append-b', 'append-a'] };
const demoResolution = resolveWorkflowSteps(demoWorkflow, (id) => demoModules.find((m) => m.id === id));
if (demoResolution.missing.length === 0) {
  kernel.run(demoResolution.modules, 'start').then((result) => {
    console.log('Synapse: workflow demo ->', result); // expected "start B A"
  });
}

// Smoke-test for Composite Module (kernel/composite-module.ts, docs/ROADMAP.md #3): proves
// createCompositeModule's own sequential dispatch + bypass logic, reusing the same demoModules
// above rather than registering a fake business Module into the Registry. `getSubState` stands in
// for RegistryEntry.subState — a real Composite Module instance wires this to the chrome.storage
// read the Adapter already has (see chrome-module-registry.ts's getSubStateMap).
let demoBypassAppendB = false;
const demoComposite = createCompositeModule({
  id: 'demo-composite',
  subModules: demoModules,
  getSubState: async () => (demoBypassAppendB ? { 'append-b': false } : {}),
  onSubFailure: (failure) => console.error(`Synapse: composite demo step "${failure.moduleId}" failed`, failure.error),
});
kernel
  .run([demoComposite], 'start')
  .then((result) => {
    console.log('Synapse: composite demo (no bypass) ->', result); // expected "start A B"
    demoBypassAppendB = true;
    return kernel.run([demoComposite], 'start');
  })
  .then((result) => {
    console.log('Synapse: composite demo (append-b bypassed) ->', result); // expected "start A"
  });
