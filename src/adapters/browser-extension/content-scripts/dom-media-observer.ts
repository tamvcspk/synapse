import { classifyMediaUrl } from '../../../shared/media-url-matcher';
import { showAnchoredBadge } from '../utils/floating-widget';

/**
 * Content-script infra (ISOLATED world) for network-sniffer's Phase 1 enhancement
 * (docs/ROADMAP.md #4) — not a registered `dom` Module itself (no Registry entry, no Gear/Arrow
 * icon), just a second detection source feeding the same `network-sniffer` Module's storage.
 * `chrome.webRequest` (the Module's primary mechanism) only sees a `<video>`/`<audio>` source once
 * a real request for it fires — this closes the gap for a source that's already in the DOM but
 * hasn't been played/requested yet (lazy players, `preload="none"`).
 *
 * `blob:`-sourced MSE video isn't handled — `classifyMediaUrl` returns undefined for those (no
 * dot-extension to match), so they're silently skipped, which is correct: a blob: URL is scoped to
 * this page's own JS realm and isn't fetchable from any other context anyway.
 *
 * docs/ROADMAP.md #4.2 — also shows a small download badge anchored to each detected element's
 * corner (utils/floating-widget.ts's showAnchoredBadge), purely locally: this content script
 * already holds the actual DOM element and its resolved URL, so there's no need for a background
 * round trip just to decide "show a widget here" the way the webRequest-only path needs (that path
 * has no DOM visibility at all — see network-sniffer/index.ts's notifyTabMediaFound, which is the
 * *only* remaining source of the page-corner toast now that DOM-visible media gets its own badge).
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
}

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
  return candidates;
}

function showBadges(candidates: CandidateMedia[]): void {
  for (const { element, url } of candidates) {
    if (!classifyMediaUrl(url)) continue;
    showAnchoredBadge({
      id: `network-sniffer:${url}`,
      target: element,
      label: '⬇',
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
  report(candidates.map((c) => c.url));
}

/** Idempotent per page load — content-scripts/index.ts only calls this once, when the Module is
 * active, so no install/teardown pair is needed here (unlike the background-side observer, this
 * doesn't outlive the page). */
export function installDomMediaObserver(): void {
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
