import '@picocss/pico/css/pico.min.css';
import './popup.css';
import type { RegistryEntry } from '../../../../kernel/module-registry';
import { isCollectionSchema } from '../../../../kernel/ui-schema';
import { ChromeModuleRegistryService } from '../../module-registry/chrome-module-registry';
import { isUserScriptsPermissionGranted } from '../../module-registry/storage';
import { triggerModuleAction } from './module-trigger';
import { openReviewPage } from './review-handoff';
import { render as renderView, type RouterHandlers, type View } from './router';

/** Fire-and-forget progress pings from a long-running action (docs/ROADMAP.md #1's Crawl &
 * Convert Site, `reader-mode-converter.module.ts`'s `crawlSite`) — sent via the general
 * `chrome.runtime.sendMessage` broadcast channel, independent of `triggerModuleAction`'s
 * request/response pair below (which only ever resolves once, at the very end). Not specific to
 * any one module — any action could adopt this convention. */
interface CrawlProgressMessage {
  type: 'reader-mode-crawl-progress';
  done: number;
  total: number;
}

function isCrawlProgressMessage(message: unknown): message is CrawlProgressMessage {
  return !!message && typeof message === 'object' && (message as Record<string, unknown>).type === 'reader-mode-crawl-progress';
}

/** Subscribes to progress pings for the duration of one action trigger; returns the unsubscribe. */
function listenForProgress(onProgress: (message: string) => void): () => void {
  const listener = (message: unknown) => {
    if (isCrawlProgressMessage(message)) onProgress(`Crawling... ${message.done}/${message.total} pages`);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

const registry = new ChromeModuleRegistryService();
const root = document.getElementById('root')!;

// The Dashboard page (docs/ROADMAP.md #2.5) — a standalone Tab hosting the Collection-schema
// CRUD flow that used to be the popup's 'management'/'item-form' views. Path must match the entry
// key vite.config.ts registers for `ui/dashboard/index.html`.
const DASHBOARD_PATH = 'src/adapters/browser-extension/ui/dashboard/index.html';
// The Review page (docs/ROADMAP.md #3) — a standalone Tab for an Action-schema module whose
// uiSchema declares `resultView: 'files'`. Path must match the entry key vite.config.ts registers
// for `ui/review/index.html`.
const REVIEW_PATH = 'src/adapters/browser-extension/ui/review/index.html';

let view: View = { kind: 'list' };
let entries: RegistryEntry[] = [];
let userScriptsPermissionGranted = true;

const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = '.js';
fileInput.style.display = 'none';
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  await registry.uploadModule(await file.text());
  await load();
});
document.body.append(fileInput);

async function load(): Promise<void> {
  const [nextEntries, granted] = await Promise.all([registry.list(), isUserScriptsPermissionGranted()]);
  entries = nextEntries;
  userScriptsPermissionGranted = granted;
  await render();
}

async function render(): Promise<void> {
  await renderView(root, view, entries, handlers, { userScriptsPermissionGranted });
}

function navigate(next: View): void {
  view = next;
  void render();
}

const handlers: RouterHandlers = {
  onToggle: handleToggle,
  onGrant: handleGrant,
  onUpload: () => fileInput.click(),
  onRefresh: handleRefresh,
  onOpenModule: handleOpenModule,
  onOpenSteps: handleOpenSteps,
  onNavigate: navigate,
  onConsentApprove: handleConsentApprove,
  onConsentDeny: () => navigate({ kind: 'list' }),
};

// Navigation Flow (docs/ROADMAP.md #2, extended by #2.5): a Collection schema opens the Dashboard
// page in its own Tab (no longer an in-popup view — see DASHBOARD_PATH above); an Action schema
// (no persisted collection, e.g. reader-mode-converter) triggers run() directly and shows the
// result in place, per the schema's shape rather than a boolean flag.
/** Shared by the Collection-schema branch below and `handleOpenSteps` — both just need the
 * Dashboard tab open on this module's id, closing the popup right after. */
function openDashboard(entry: RegistryEntry): void {
  const url = `${chrome.runtime.getURL(DASHBOARD_PATH)}?moduleId=${encodeURIComponent(entry.id)}`;
  void chrome.tabs.create({ url });
  window.close();
}

function handleOpenSteps(entry: RegistryEntry): void {
  openDashboard(entry);
}

async function handleOpenModule(entry: RegistryEntry, actionId?: string): Promise<void> {
  const schema = entry.uiSchema;
  if (!schema) return;

  if (isCollectionSchema(schema)) {
    openDashboard(entry);
    return;
  }

  // Defaults to the first action — matches list-view.ts's own default for a plain label click.
  const action = schema.actions.find((a) => a.id === actionId) ?? schema.actions[0];
  if (!action) return;

  // Shown immediately — most actions resolve in a second or two (this just flashes briefly), but
  // a long-running one (Crawl & Convert Site) keeps this updated via progress pings, so the user
  // has a clear reason to wait instead of clicking away (which would lose the response — the
  // request/response pair below only ever resolves once, at the very end).
  navigate({ kind: 'busy', message: 'Running...' });
  const stopProgress = listenForProgress((message) => navigate({ kind: 'busy', message }));

  let result: Awaited<ReturnType<typeof triggerModuleAction>>;
  try {
    result = await triggerModuleAction(entry.id, { action: action.id });
  } finally {
    stopProgress();
  }

  if (!result.ok) {
    // "Could not establish connection. Receiving end does not exist." is Chrome's standard
    // message for "no content script listening in that tab" — friendlier prefix, but still show
    // the raw message rather than hiding it.
    const hint = result.error?.includes('Receiving end does not exist')
      ? 'This page could not be reached (try reloading the tab, or it may be a restricted page). '
      : '';
    navigate({ kind: 'action-result', title: `${entry.label ?? entry.id} — Error`, content: `${hint}${result.error ?? 'Unknown error'}`, isError: true });
    return;
  }

  if (action.resultView === 'files') {
    const outcome = await openReviewPage(result.data);
    if (!outcome.ok) {
      navigate({
        kind: 'action-result',
        title: `${entry.label ?? entry.id} — Error`,
        content: outcome.error ?? 'Unknown error',
        isError: true,
      });
      return;
    }
    const url = `${chrome.runtime.getURL(REVIEW_PATH)}?reviewId=${encodeURIComponent(outcome.reviewId!)}`;
    void chrome.tabs.create({ url });
    window.close();
    return;
  }

  const data = result.data as Record<string, unknown> | undefined;
  const title = typeof data?.title === 'string' ? data.title : (entry.label ?? entry.id);
  const content = typeof data?.markdown === 'string' ? data.markdown : JSON.stringify(data, null, 2);
  navigate({ kind: 'action-result', title, content, isError: false });
}

function handleGrant(entry: RegistryEntry): void {
  const ungranted = entry.needs.filter((n) => !entry.grantedCapabilities.includes(n));
  if (ungranted.length === 0) return;
  navigate({ kind: 'capability-consent', moduleId: entry.id, capabilities: ungranted, intent: 'grant' });
}

function handleToggle(entry: RegistryEntry): void {
  if (entry.active) {
    void registry.deactivate(entry.id).then(load);
    return;
  }
  if (entry.needs.length > 0) {
    navigate({ kind: 'capability-consent', moduleId: entry.id, capabilities: entry.needs, intent: 'toggle' });
    return;
  }
  void registry.activate(entry.id).then(load);
}

async function handleConsentApprove(): Promise<void> {
  if (view.kind !== 'capability-consent') return;
  const { moduleId, capabilities, intent } = view;
  const entry = entries.find((e) => e.id === moduleId);
  const grantedCapabilities = entry?.grantedCapabilities ?? [];
  await registry.grantCapabilities(moduleId, [...grantedCapabilities, ...capabilities]);
  if (intent === 'toggle') await registry.activate(moduleId);
  view = { kind: 'list' };
  await load();
}

async function handleRefresh(): Promise<void> {
  await registry.refresh();
  await load();
}

void load();
