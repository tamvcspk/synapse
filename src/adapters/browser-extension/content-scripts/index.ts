import { registerDomModule } from './relay';
import { buildDomModuleApi } from './rpc-client';
import { BUNDLED_MODULES } from '../module-registry/bundled-modules';
import { getUiMutedMap, isModuleActive } from '../module-registry/storage';
import { installStorageToMainWorldRelay } from '../utils/main-world/storage-relay';
import { createMainWorldChannel } from '../utils/main-world/event-channel';
import { createUiSurface, installUiStyles, setOwnerUiHidden } from '../utils/ui-compositor';
import { onUiVisibilityChanged } from '../module-registry/ui-visibility';
import { MOCK_CONFIG_CHANNEL_ID, MOCK_CONFIG_STORAGE_KEY } from '../features/http-mock/constants';
import { MAIN_WORLD_REPORT_CHANNEL_ID } from '../features/media/constants';
import { SUBSCRIPTION_EVENT_MESSAGE_TYPE, SUBSCRIPTION_PUSH_CHANNEL_ID, type SubscriptionPushPayload } from '../../../shared/subscription-bridge';

// Generic infra call (not a Module — see main-world-interceptor skill): forwards
// http-error-mocker's persisted MockConfig list into its MAIN-world interceptor whenever it's
// registered. Kept explicit rather than auto-discovered — only one feature needs this today.
installStorageToMainWorldRelay(MOCK_CONFIG_STORAGE_KEY, MOCK_CONFIG_CHANNEL_ID);

// network-sniffer's DOM/iframe detection (docs/ROADMAP.md #4) lives in a SEPARATE
// `all_frames: true` content_scripts entry (frame-media-observer.content.ts), not here — this file's entry
// stays top-frame-only (all_frames defaults to false) because chrome.tabs.sendMessage broadcasts to
// every frame when no frameId is given, and putting registerDomModule (below) in every iframe would
// let multiple frames race to answer the same trigger message.

// docs/ROADMAP.md §6.1 — persistent floating icon (top-right), replacing the old bottom-right
// toast, for network-sniffer's push (features/media/network-sniffer.background.ts's
// notifyTabMediaFound). Registered here (not frame-media-observer.content.ts) for the same top-frame-only
// reason as registerDomModule above: showing one icon per page, not one per iframe. No
// count/message — see the `icon` doc comment in ui-compositor.ts for why. Click messages background to open
// the Side Panel (synapse:open-side-panel, background/index.ts) rather than a real
// `chrome.sidePanel` call — content scripts don't have that API at all.
//
// docs/ROADMAP.md §11.4 — each owner gets its OWN surface, constructed here (the composition root)
// from a build-time Module id. That id is the only identity the compositor trusts; nothing below
// can name another owner's surface, which is what the old shared `showFloatingIcon(id)` allowed.
const snifferUi = createUiSurface('network-sniffer');
const readerUi = createUiSurface('reader-mode-converter');

// UNCONDITIONAL, and it must stay that way. This content script is the only party that holds the
// compositor's stylesheet, and uploaded scripts (USER_SCRIPT world) rely on it having been
// installed. Making it conditional on any bundled Module actually drawing — which is what the code
// did implicitly before — leaves every uploaded script's UI unstyled on the many pages where no
// bundled Module has anything to show. See installUiStyles' doc comment.
installUiStyles();

// Seed the hide flags into the DOM as early as possible. The USER_SCRIPT world cannot read
// `chrome.storage` at all, so this content script is the only party that can publish them — and it
// has to happen without waiting for a change event, or a muted script would draw normally on every
// fresh page load. The read is async, so a surface created in the meantime can slip through; that
// is why `setOwnerUiHidden` also marks containers that already exist, making the late arrival
// self-healing rather than permanent.
void (async () => {
  for (const [id, muted] of Object.entries(await getUiMutedMap())) {
    if (muted) setOwnerUiHidden(id, true);
  }
})();

function showNetworkSnifferIcon(): void {
  snifferUi.icon({
    id: 'open-panel',
    label: '⬇',
    title: 'Media detected on this page — click to view',
    onClick: () => {
      chrome.runtime.sendMessage({ type: 'synapse:open-side-panel' }).catch(() => {});
    },
  });
}

chrome.runtime.onMessage.addListener((message: { type?: string } | undefined) => {
  if (message?.type !== 'synapse:media-found') return;
  void (async () => {
    if (!(await isModuleActive('network-sniffer', false))) return;
    showNetworkSnifferIcon();
  })();
});

// docs/api-inventory.md §6 item 8 (subscription spike) — relays a background push
// (module-registry/subscription-push.ts's pushSubscriptionEvent) into a shared-window DOM
// CustomEvent, the ONLY hop that can reach the USER_SCRIPT world (it has no chrome.runtime.onMessage
// route from the extension side — see user-script-shim.ts's trailer() for the sibling attempt that
// is suspected dead for the exact reason this file's approach avoids: no messaging API, only DOM).
// This dispatch also reaches the page's own MAIN world, same as every other main-world channel this
// codebase uses (MOCK_CONFIG_CHANNEL_ID, MAIN_WORLD_REPORT_CHANNEL_ID) — the page could in principle
// listen for this event name too, the same accepted tradeoff those channels already make.
const subscriptionPushChannel = createMainWorldChannel<SubscriptionPushPayload>(SUBSCRIPTION_PUSH_CHANNEL_ID);
chrome.runtime.onMessage.addListener((message: { type?: string; topic?: string; data?: unknown } | undefined) => {
  if (message?.type !== SUBSCRIPTION_EVENT_MESSAGE_TYPE || typeof message.topic !== 'string') return;
  subscriptionPushChannel.dispatch({ topic: message.topic, data: message.data });
});

// docs/ROADMAP.md #4.1 — relays network-sniffer's MAIN-world observer (main-world-payload.ts) to
// background purely for persistence into the Dashboard's detected-media list. Registered here
// (top-frame-only), matching where the MAIN-world script itself runs — registerMainWorldScript
// doesn't set `allFrames`, so it defaults to top-frame-only, same as http-error-mocker's. Separate
// from dom-media-observer.content.ts's OWN listener on this same channel (badge-anchoring correlation,
// no relay needed there — see that file) — two independent listeners on the same shared-window
// CustomEvent, one per purpose.
createMainWorldChannel<{ url: string }>(MAIN_WORLD_REPORT_CHANNEL_ID).onUpdate(({ url }) => {
  chrome.runtime
    .sendMessage({ event: 'network-sniffer', payload: { op: 'report-main-world-media', url, pageUrl: location.href } })
    .catch(() => {});
  // docs/ROADMAP.md §6.3 — shown optimistically, without waiting for background's own junk-filter
  // re-validation (report-main-world-media's server-side isJunkUrl/classifyMediaUrl check) — this
  // content script is already the top frame, the same one that owns the floating icon, so there's
  // no round trip needed to know "this page has media" the way the webRequest-only path does.
  void (async () => {
    if (await isModuleActive('network-sniffer', false)) showNetworkSnifferIcon();
  })();
});

// Every BUNDLED_MODULE is a dom Module by construction — bundled-modules.ts globs
// `features/*/**/*.module.ts` and nothing else. The old `needs?.includes('dom')` filter here was
// redundant with that, and `'dom'` is gone as a Capability anyway (docs/ROADMAP.md §11.3: it
// resolved to no service, so declaring it was a silent no-op; what a script can do to the page is
// now the `page.dom` *scope*, which is Disclosed rather than injected).
const domModules = BUNDLED_MODULES;

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
    if (!(await isModuleActive(mod.id, !mod.templateId))) return;
    try {
      await mod.run(undefined, { services: {}, api: buildDomModuleApi(mod.id) });
    } catch (err) {
      console.error(`Synapse: module "${mod.id}" failed on auto-run`, err);
    }
  })();
}

// docs/ROADMAP.md §9.1 — Reader Mode Converter's trigger: two floating icons (top-right, stacked
// alongside network-sniffer's in the same compositor zone — different OWNERS now, so ids cannot
// collide at all), always shown while the module is active (unlike network-sniffer's icon, there's no
// "detected" event to gate on here — "can I convert this page" is always true). Replaces the old
// Popup action-button trigger entirely (docs/ROADMAP.md §9.1's evaluation: a Popup-triggered crawl
// can outlive the popup and also backgrounds the very tab doing the crawling). Runs `run()`
// in-process — trigger and execution are already the same content-script context, no
// chrome.tabs.sendMessage round trip needed the way the Popup's old path required.
let readerModeJobRunning = false;

async function runReaderModeJob(mod: (typeof domModules)[number], actionId: 'convert-page' | 'crawl-site'): Promise<void> {
  if (readerModeJobRunning) return;
  readerModeJobRunning = true;
  try {
    const result = await mod.run({ action: actionId }, { services: {}, api: buildDomModuleApi(mod.id) });
    chrome.runtime.sendMessage({ type: 'synapse:reader-mode-result', data: result }).catch(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    chrome.runtime.sendMessage({ type: 'synapse:reader-mode-error', message }).catch(() => {});
  } finally {
    readerModeJobRunning = false;
  }
}

function showReaderModeIcons(): void {
  const mod = domModules.find((m) => m.id === 'reader-mode-converter');
  if (!mod) return;

  // Fires the Side Panel open SYNCHRONOUSLY (no await before it — see relay.ts's doc comment on
  // this exact gotcha) before kicking off the (potentially long) run() call.
  const trigger = (actionId: 'convert-page' | 'crawl-site') => () => {
    chrome.runtime.sendMessage({ type: 'synapse:open-side-panel' }).catch(() => {});
    void runReaderModeJob(mod, actionId);
  };

  // Two icons is exactly the compositor's per-owner icon quota (shared/ui/surface-policy.ts) — the
  // cap was set to 2 BECAUSE of this consumer, not the other way round.
  readerUi.icon({
    id: 'convert',
    label: '📄',
    title: 'Convert this page to Markdown',
    onClick: trigger('convert-page'),
  });
  readerUi.icon({
    id: 'crawl',
    label: '🕸️',
    title: 'Crawl & convert this whole site',
    onClick: trigger('crawl-site'),
  });
}

void (async () => {
  if (await isModuleActive('reader-mode-converter', false)) showReaderModeIcons();
})();

// docs/ROADMAP.md §11.4 — Core owns the surface lifecycle, so switching a Module off (or muting just
// its UI) has to take the UI down on pages that are ALREADY open, not only on the next load. Both
// signals arrive on the same storage change, so they are handled in one place: mute is the valve
// that leaves the Module running, deactivate stops it entirely.
onUiVisibilityChanged((moduleId, visible) => {
  // `setOwnerUiHidden`, not a bare `destroyUiSurface`: the flag has to be written to the DOM or it
  // never reaches the USER_SCRIPT world, which has no `chrome.storage` to read it from. Tearing the
  // surfaces down without recording the flag looked like it worked only because the uploaded
  // scripts in the test fixture had already finished drawing — their next `ui.toast()` would have
  // returned `true` and drawn again, valve or no valve.
  setOwnerUiHidden(moduleId, !visible);
  if (!visible) return;

  // Un-hiding needs no redraw — the surfaces were never destroyed, only hidden — so this call is
  // purely for the case where the page loaded while the Module was hidden and its icons were
  // therefore never drawn at all. `icon()` returns the existing element when there is one, so
  // running it again costs nothing. network-sniffer is deliberately absent: its icon means "media
  // was found here", and conjuring one on unmute would assert something untrue until the next
  // detection.
  if (moduleId === 'reader-mode-converter') showReaderModeIcons();
});
