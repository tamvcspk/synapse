/**
 * Item 1's missing trigger: invokes an Action-schema dom Module's run() on the active tab's
 * content script. chrome.tabs.sendMessage delivers only to that one tab's content script (where
 * content-scripts/relay.ts's registerDomModule listener lives) — it doesn't reach background or
 * other tabs, and needs no extra manifest permission (tab id access doesn't require "tabs";
 * only reading url/title would).
 *
 * Lives at `ui/` (not `ui/popup/`) since it's generic Action-schema Popup infrastructure, not
 * specific to any one module.
 */
export interface TriggerResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export async function triggerModuleAction(moduleId: string, input?: unknown): Promise<TriggerResult> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return { ok: false, error: 'No active tab to run this module against.' };
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { moduleId, input });
    if (response && typeof response === 'object' && 'error' in response) {
      return { ok: false, error: String((response as { error: unknown }).error) };
    }
    return { ok: true, data: response };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
