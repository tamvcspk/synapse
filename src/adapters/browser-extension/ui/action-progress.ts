/**
 * Fire-and-forget progress pings from a long-running action (docs/ROADMAP.md §9.1's Crawl &
 * Convert Site, `reader-mode-converter.module.ts`'s `crawlSite`) — sent via the general
 * `chrome.runtime.sendMessage` broadcast channel. `chrome.runtime.sendMessage` reaches every
 * extension context currently listening (background, popup, any open extension tab/panel) — so
 * this same listener works unchanged whether it's the popup (a fast Action-schema module that
 * still takes a beat, via `module-trigger.ts`'s request/response pair) or the Side Panel (§9.1's
 * in-page-icon-triggered job, which runs entirely in the content script, no request/response pair
 * at all) doing the listening. Not specific to any one module — any action could adopt this
 * convention.
 */
export interface ActionProgressMessage {
  type: 'reader-mode-crawl-progress';
  done: number;
  total: number;
}

function isActionProgressMessage(message: unknown): message is ActionProgressMessage {
  return !!message && typeof message === 'object' && (message as Record<string, unknown>).type === 'reader-mode-crawl-progress';
}

/** `done`/`total` are passed through raw (not just baked into `message`) so a caller with room for
 * a real determinate `<progress value max>` — the Side Panel's Reader Mode section — can render
 * actual fill instead of a plain indeterminate spinner; a caller that only has room for one line of
 * text (the popup's busy view) can just read `message`. */
export interface ActionProgress {
  message: string;
  done: number;
  total: number;
}

/** Subscribes to progress pings for the duration of one action trigger; returns the unsubscribe. */
export function listenForActionProgress(onProgress: (progress: ActionProgress) => void): () => void {
  const listener = (message: unknown) => {
    if (isActionProgressMessage(message)) {
      onProgress({ message: `Crawling... ${message.done}/${message.total} pages`, done: message.done, total: message.total });
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
