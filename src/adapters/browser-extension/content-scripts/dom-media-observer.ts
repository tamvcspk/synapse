import { classifyMediaUrl } from '../../../shared/media-url-matcher';
import { createMainWorldChannel } from '../utils/main-world/event-channel';
import { createUiSurface } from '../utils/ui-compositor';
import {
  MAIN_WORLD_REPORT_CHANNEL_ID,
  MAIN_WORLD_CORRELATION_CHANNEL_ID,
  MAIN_WORLD_HLS_CORRELATION_CHANNEL_ID,
  HLS_CORRELATION_ATTRIBUTE,
} from '../background/modules/network-sniffer/constants';

/**
 * Content-script infra (ISOLATED world) for network-sniffer's Phase 1 enhancement
 * (docs/ROADMAP.md #4) — not a registered `dom` Module itself (no Registry entry, no Gear/Arrow
 * icon), just a second detection source feeding the same `network-sniffer` Module's storage.
 * `chrome.webRequest` (the Module's primary mechanism) only sees a `<video>`/`<audio>` source once
 * a real request for it fires — this closes the gap for a source that's already in the DOM but
 * hasn't been played/requested yet (lazy players, `preload="none"`).
 *
 * docs/ROADMAP.md #4.2 — also shows a small download badge anchored to each detected element's
 * corner (utils/ui-compositor.ts's `badge`), purely locally: this content script
 * already holds the actual DOM element and its resolved URL, so there's no need for a background
 * round trip just to decide "show a widget here" the way the webRequest-only path needs (that path
 * has no DOM visibility at all — see network-sniffer/index.ts's notifyTabMediaFound, which is the
 * *only* remaining source of the page-corner toast now that DOM-visible media gets its own badge).
 *
 * docs/ROADMAP.md #4.1 — `blob:`-sourced MSE video (hls.js/dash.js-style players, `classifyMediaUrl`
 * correctly returns undefined for it — a blob: URL isn't fetchable outside its own JS realm) used
 * to be silently skipped entirely, leaving the actual content the user wants with no download
 * affordance while ad `<video>`s with plain URLs got one. This file listens to network-sniffer's
 * MAIN-world observer (main-world-payload.ts, shares this frame's `window` when both run in the top
 * frame) for the manifest/media URL the player's own JS actually fetches, and correlates it to a
 * `blob:` `<video>`/`<audio>` element as an anchor target.
 *
 * docs/ROADMAP.md #7.3 — three correlation signals, checked in precision order in
 * `collectCandidates()` below (was a single page-global heuristic before this, which a page with
 * multiple simultaneous MSE players would mis-anchor): (1) `HLS_CORRELATION_ATTRIBUTE`, set directly
 * on the exact element by hls-global-hook.ts's `MANIFEST_LOADED` handler — an exact pairing, no
 * guessing; (2) `blobUrlCorrelation`, a `blob: URL -> manifest URL` map fed by
 * media-source-interceptor.ts's generic MediaSource hook — an exact match on the blob: URL itself,
 * though the manifest URL side is still a time-window guess (see that file's doc comment); (3)
 * `playCorrelatedUrl`, populated only when a SPECIFIC element's own `'play'` event fires — the last
 * resort, for a blob: element neither of the above could place, now scoped to the element that
 * actually started playing instead of applied to every blob: element on the page.
 */

interface DomMediaItem {
  url: string;
  pageUrl: string;
}

interface CandidateMedia {
  /** The <video>/<audio> element to anchor a badge to — never a bare <source>, which has no
   * rendered box of its own (not painted), so anchoring to it would misplace the badge invisibly. */
  element: HTMLMediaElement;
  url: string;
  /** True when `url` is a best-effort MAIN-world correlation (see file doc comment), not the
   * element's own resolved src — `report()` skips these (already persisted once via the
   * MAIN-world path) and `showBadges` skips the redundant classifyMediaUrl check (already
   * validated before being dispatched from main-world-payload.ts). */
  correlated?: boolean;
}

// docs/ROADMAP.md #7.3(a) — blob: object URL -> best-effort correlated manifest/media URL, fed by
// main-world-payload.ts's MediaSource/createObjectURL hook. Keyed by the ACTUAL blob: URL a specific
// element's src resolves to, so multiple simultaneous MSE players on the page no longer collide the
// way the old single global did.
const blobUrlCorrelation = new Map<string, string>();

// docs/ROADMAP.md #7.3's 'play' signal — last-resort fallback only, for a blob: element with neither
// an HLS_CORRELATION_ATTRIBUTE match nor a blobUrlCorrelation entry. Populated only when THIS
// SPECIFIC element starts playing (capture-phase 'play' below), not applied to every blob: element
// on the page like the old single global was.
const playCorrelatedUrl = new WeakMap<HTMLMediaElement, string>();
// Most recently observed MAIN-world media/manifest URL — used ONLY inside the 'play' handler below
// to populate playCorrelatedUrl for the element that just started playing, never applied blindly to
// every blob: element on a scan (that was the old, coarser behavior this file used to have).
let mostRecentlyObservedUrl: string | undefined;

function collectCandidates(): CandidateMedia[] {
  const seen = new Set<string>();
  const candidates: CandidateMedia[] = [];
  for (const el of document.querySelectorAll('video, audio, source')) {
    const src = (el instanceof HTMLMediaElement ? el.currentSrc : undefined) || el.getAttribute('src');
    const anchor = el.closest('video, audio');
    if (!src || seen.has(src) || !(anchor instanceof HTMLMediaElement)) continue;
    seen.add(src);
    candidates.push({ element: anchor, url: src });
  }

  // blob:/MSE players never expose a fetchable src at all (see file doc comment) — anchor each one
  // to whichever correlation signal is available for THIS SPECIFIC element, in precision order
  // (docs/ROADMAP.md #7.3): an exact hls.js MANIFEST_LOADED tag, an exact MediaSource/
  // createObjectURL blob: URL match, or (last resort) the URL observed around when this exact
  // element started playing.
  for (const el of document.querySelectorAll('video, audio')) {
    if (!(el instanceof HTMLMediaElement)) continue;
    const src = el.currentSrc || el.getAttribute('src');
    if (!src?.startsWith('blob:')) continue;
    const correlatedUrl = el.getAttribute(HLS_CORRELATION_ATTRIBUTE) ?? blobUrlCorrelation.get(src) ?? playCorrelatedUrl.get(el);
    if (correlatedUrl) candidates.push({ element: el, url: correlatedUrl, correlated: true });
  }

  return candidates;
}

// One surface for this owner (docs/ROADMAP.md §11.4). The id is the Module's, supplied here at the
// composition point — never passed in by whatever calls showBadges — so nothing downstream can
// address another owner's UI. Badge ids are local to this surface, hence the bare `url`: two owners
// badging the same URL get two distinct keys.
const ui = createUiSurface('network-sniffer');

function showBadges(candidates: CandidateMedia[]): void {
  for (const { element, url, correlated } of candidates) {
    if (!correlated && !classifyMediaUrl(url)) continue;
    ui.badge({
      id: url,
      target: element,
      label: '⬇',
      ...(correlated ? { title: "Best-effort match — this player streams via a technique we can't inspect directly" } : {}),
      onClick: () => {
        chrome.runtime.sendMessage({ type: 'synapse:download-media', url }).catch(() => {
          // No listener (e.g. background just restarted) — best-effort, same posture as `report`.
        });
      },
    });
  }
}

function report(urls: string[]): void {
  const items: DomMediaItem[] = urls
    .filter((url) => classifyMediaUrl(url))
    .map((url) => ({ url, pageUrl: location.href }));
  if (items.length === 0) return;

  chrome.runtime.sendMessage({ event: 'network-sniffer', payload: { op: 'report-dom-media', items } }).catch(() => {
    // No listener (e.g. background just restarted) — best-effort, same posture as the crawl
    // progress pings in reader-mode-converter.module.ts.
  });
}

function scanNow(): void {
  const candidates = collectCandidates();
  showBadges(candidates);
  // Correlated candidates aren't real DOM-resolved detections — already persisted once via
  // network-sniffer/index.ts's report-main-world-media handling, don't double-report them here.
  report(candidates.filter((c) => !c.correlated).map((c) => c.url));
}

/** Idempotent per page load — content-scripts/index.ts only calls this once, when the Module is
 * active, so no install/teardown pair is needed here (unlike the background-side observer, this
 * doesn't outlive the page). */
export function installDomMediaObserver(): void {
  // docs/ROADMAP.md #4.1 — shares this frame's `window` with network-sniffer's MAIN-world script
  // when both run in the top frame (a nested iframe's instance of this file simply never receives
  // an event, since the MAIN-world script is top-frame-only — see main-world-payload.ts). Triggers
  // an immediate re-scan: a `preload="none"` player (the motivating case) may not fetch its
  // manifest until playback starts, well after the MutationObserver below last fired.
  createMainWorldChannel<{ url: string }>(MAIN_WORLD_REPORT_CHANNEL_ID).onUpdate(({ url }) => {
    mostRecentlyObservedUrl = url;
    scanNow();
  });

  // docs/ROADMAP.md #7.3(a) — the generic MediaSource/createObjectURL correlation signal.
  createMainWorldChannel<{ blobUrl: string; url: string }>(MAIN_WORLD_CORRELATION_CHANNEL_ID).onUpdate(({ blobUrl, url }) => {
    blobUrlCorrelation.set(blobUrl, url);
    scanNow();
  });

  // docs/ROADMAP.md §7.3(a-hls) bugfix — hls-global-hook.ts's exact-match signal sets
  // HLS_CORRELATION_ATTRIBUTE directly on the DOM, which the MutationObserver below can't see (it's
  // scoped to attributeFilter: ['src'], not this custom attribute) — this explicit signal is what
  // actually triggers the rescan that picks the attribute back up. Empty payload, re-reads the
  // attribute fresh in collectCandidates() rather than carrying the value itself.
  createMainWorldChannel<Record<string, never>>(MAIN_WORLD_HLS_CORRELATION_CHANNEL_ID).onUpdate(() => {
    scanNow();
  });

  // docs/ROADMAP.md #7.3's 'play' signal — capture phase so a page's own stopPropagation() on the
  // bubble phase can't hide this from us. Scopes the "most recently observed URL" guess to the
  // EXACT element that just started playing, instead of applying it to every blob: element on the
  // page (the old, coarser behavior) — still just a heuristic, but a much narrower one.
  document.addEventListener(
    'play',
    (event) => {
      if (!(event.target instanceof HTMLMediaElement) || !mostRecentlyObservedUrl) return;
      const src = event.target.currentSrc || event.target.getAttribute('src');
      if (!src?.startsWith('blob:')) return;
      playCorrelatedUrl.set(event.target, mostRecentlyObservedUrl);
      scanNow();
    },
    true,
  );

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanNow, { once: true });
  } else {
    scanNow();
  }

  // Catches lazy players / SPA navigations that insert <video>/<audio> after initial load.
  const observer = new MutationObserver((mutations) => {
    const touchesMedia = mutations.some((m) => {
      if (m.type === 'attributes') return m.target instanceof Element && ['VIDEO', 'AUDIO', 'SOURCE'].includes(m.target.tagName);
      return [...m.addedNodes].some(
        (node) => node instanceof Element && (['VIDEO', 'AUDIO', 'SOURCE'].includes(node.tagName) || node.querySelector('video, audio, source')),
      );
    });
    if (touchesMedia) scanNow();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
}
