import { Kernel } from '../../../kernel';
import { ServiceInjector } from '../../../kernel/service-injector';
import { registerRpcHandler } from '../module-registry/rpc-handler';
import { BACKGROUND_MODULES } from '../module-registry/background-modules';
import { setUserScriptsPermissionGranted } from '../module-registry/storage';
import { DASHBOARD_PATH } from '../ui/dashboard/dashboard-path';
import { SIDE_PANEL_PATH } from '../ui/side-panel/side-panel-path';
import { ensureOffscreenDocument } from '../utils/offscreen-manager';
import { describeHeaderReplay, syncHeaderReplayRule } from '../utils/header-replay-rules';
import { listDetectedMedia } from './modules/network-sniffer/store';
import { listDownloadJobCheckpoints, saveDownloadJobCheckpoint, removeDownloadJobCheckpoint } from '../utils/download-job-checkpoints';
import type { DownloadEngineCommand, DownloadEngineRelayedCommand, DownloadJobCheckpoint } from '../../../shared/download-engine-protocol';
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

// docs/ROADMAP.md §8.1 — Side Panel/Dashboard send this to START/PAUSE/RESUME/CANCEL an HLS
// download; only background can own chrome.offscreen.createDocument (utils/offscreen-manager.ts),
// so this relay ensures the singleton Offscreen Document exists BEFORE forwarding it on.
//
// Bugfix: this used to re-send the message under the SAME `type` it received — but
// `chrome.runtime.sendMessage` broadcasts to every listening context, not just the intended
// recipient. Once the offscreen document already exists (any download after the first one in a
// session), its own listener received the Side Panel's ORIGINAL broadcast directly, then received
// THIS relay's re-broadcast a moment later too — the same command landed twice, which was the real
// trigger behind a job hitting an OPFS `InvalidStateError` (two overlapping `createOpfsRun` calls
// for what was meant to be a single job). Re-typed to `DownloadEngineRelayedCommand`
// (`synapse:download-engine-command-relayed`) — a type the offscreen document is the ONLY listener
// for (ui/offscreen/main.ts no longer listens for the client-facing type at all), so it structurally
// cannot receive the original broadcast a second time.
chrome.runtime.onMessage.addListener((message: DownloadEngineCommand | undefined) => {
  if (message?.type !== 'synapse:download-engine-command') return;
  const relayed: DownloadEngineRelayedCommand = { ...message, type: 'synapse:download-engine-command-relayed' };
  void ensureOffscreenDocument().then(() => chrome.runtime.sendMessage(relayed).catch(() => {}));
});

/**
 * docs/ROADMAP.md §8.11 — bugfix: Offscreen Documents can use ONLY `chrome.runtime` (confirmed
 * against Chrome's own docs after a real download hit `chrome.downloads.download()` throwing
 * "Cannot read properties of undefined" from inside `utils/download-engine.ts`). `chrome.storage`,
 * `chrome.declarativeNetRequest`, and `chrome.downloads` are all unavailable there — the first two
 * failed SILENTLY (swallowed by a `.catch()`), quietly breaking §7.1's header replay for every
 * download since the engine moved into the Offscreen Document; only `chrome.downloads` crashed
 * loudly, which is what actually surfaced this. Background is the one context with full `chrome.*`
 * access, so it now does all three on the engine's behalf via simple request/response relays —
 * each using the `sendResponse`+`return true` pattern, and each gated on its own message `type`
 * before it ever calls `sendResponse` (a listener without that guard answers messages meant for
 * other listeners and wins the race; see docs/LESSONS.md).
 */
chrome.runtime.onMessage.addListener((message: { type?: string; url?: string } | undefined, _sender, sendResponse) => {
  if (message?.type !== 'synapse:query-replay-headers' || !message.url) return;
  const url = message.url;
  void listDetectedMedia().then((all) => {
    const match = all.find((m) => m.url === url || m.variants?.some((v) => v.url === url));
    sendResponse({ headers: match?.requestHeaders });
  });
  return true;
});

chrome.runtime.onMessage.addListener((message: { type?: string; host?: string; headers?: Record<string, string> } | undefined, _sender, sendResponse) => {
  if (message?.type !== 'synapse:sync-header-replay-rule' || !message.host || !message.headers) return;
  void syncHeaderReplayRule(message.host, message.headers).then(
    () => sendResponse({ ok: true }),
    () => sendResponse({ ok: false }),
  );
  return true;
});

chrome.runtime.onMessage.addListener((message: { type?: string; host?: string } | undefined, _sender, sendResponse) => {
  if (message?.type !== 'synapse:describe-header-replay' || !message.host) return;
  void describeHeaderReplay(message.host).then(sendResponse);
  return true;
});

// docs/ROADMAP.md §8.11 — the download engine creates the Blob/blob: URL itself (inside the
// Offscreen Document — a blob: URL only resolves within the document that created it), but the
// actual `chrome.downloads.download()` call has to happen here, since that API isn't available in
// the Offscreen Document. This is Chrome's own documented pattern for downloading a Blob generated
// outside a context that has `chrome.downloads` — create the object URL there, message the URL
// string back, trigger the download from a context that has the API.
chrome.runtime.onMessage.addListener((message: { type?: string; url?: string; filename?: string } | undefined) => {
  if (message?.type !== 'synapse:trigger-download' || !message.url) return;
  void chrome.downloads.download({ url: message.url, filename: message.filename });
});

/**
 * docs/ROADMAP.md §8.12 — the Offscreen Document (utils/download-engine.ts) can't touch
 * `chrome.storage` directly (§8.11), so its periodic checkpoint writes/deletes relay through here,
 * same shape as §7.1/§8.11's other request/response relays. The READ side (`listDownloadJobCheckpoints`)
 * is deliberately NOT relayed here for the Side Panel's own use — Side Panel is a privileged
 * extension page with direct `chrome.storage` access and calls it straight, same as its existing
 * `listDetectedMedia()`/turbo-toggle reads. This listener's own `list` relay exists only for
 * ui/offscreen/main.ts, which needs the current checkpoint list BEFORE sweeping stale OPFS runs
 * (§8.9) so it doesn't delete a file a checkpoint still needs for resuming.
 */
chrome.runtime.onMessage.addListener((message: { type?: string; checkpoint?: DownloadJobCheckpoint } | undefined, _sender, sendResponse) => {
  if (message?.type !== 'synapse:save-download-checkpoint' || !message.checkpoint) return;
  void saveDownloadJobCheckpoint(message.checkpoint).then(() => sendResponse({ ok: true }));
  return true;
});

chrome.runtime.onMessage.addListener((message: { type?: string; jobId?: string } | undefined, _sender, sendResponse) => {
  if (message?.type !== 'synapse:remove-download-checkpoint' || !message.jobId) return;
  void removeDownloadJobCheckpoint(message.jobId).then(() => sendResponse({ ok: true }));
  return true;
});

chrome.runtime.onMessage.addListener((message: { type?: string } | undefined, _sender, sendResponse) => {
  if (message?.type !== 'synapse:list-download-checkpoints-for-sweep') return;
  void listDownloadJobCheckpoints().then((checkpoints) => sendResponse({ checkpoints }));
  return true;
});

// docs/ROADMAP.md §6.2, generalized §9.1 — a floating icon (utils/floating-widget.ts's
// showFloatingIcon, wired up in content-scripts/index.ts) can't call chrome.sidePanel itself
// (content scripts don't have that API), so it messages background to open it for its own tab.
// One shared listener/message for every module with a floating-icon trigger (network-sniffer's
// media icon, reader-mode-converter's Convert/Crawl icons) — the panel itself is a single page
// (SIDE_PANEL_PATH below) whose *content* branches client-side on which module has an active job,
// not by swapping paths per module.
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
  if (message?.type !== 'synapse:open-side-panel' || !sender.tab?.id) return;
  chrome.sidePanel.open({ tabId: sender.tab.id }).catch((err) => {
    console.error('Synapse: failed to open Side Panel', err);
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

// The `workflowId` message dispatch that used to live here is DELETED, not implemented
// (docs/ROADMAP.md §11.1). It had been scaffolding since day one — `kernel.run([], ...)` with a
// hardcoded empty module array, `workflowId` read by nothing — and there is still no Workflow
// defined anywhere in the repo to dispatch to. Building a resolver for zero callers would be the
// same speculative generality §11.0 just retired the second Adapter for. `kernel/workflow.ts` stays
// (it's the ordering primitive, now covered by kernel/workflow.test.ts) and Phase 5's Tier 3 is
// where user scripts get a real way to declare a chain; a message dispatch, if it's ever wanted, is
// cheaper to write then against a real caller than to keep alive as an empty shell now.

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

// The `append-a`/`append-b` Workflow smoke test and the `demo-composite` Composite Module smoke
// test that used to close this file are DELETED (docs/ROADMAP.md §11.1). They ran — and
// `console.log`'d — in every shipped build on every service-worker start, and what they proved is
// now asserted properly in kernel/workflow.test.ts and kernel/composite-module.test.ts.
