/**
 * Global SDK (docs/design.md §9): pure, no DOM, no chrome.*, no I/O.
 *
 * docs/ROADMAP.md #5.2's junk-URL reduction, round 2 — `thirdParty` (#4.1) is a label, not a
 * filter, so it never actually reduced row count. This is the other half: a small built-in list of
 * ad-network domains observed to dominate network-sniffer's false-positive noise on test sites
 * (they serve `.mp4`/`.m3u8`-looking URLs with real video Content-Types, so #4.1's Content-Type
 * trust check doesn't catch them). Deliberately a brainstorm-level starting list, not a
 * comprehensive ad-blocklist replacement — extend as new offenders show up.
 */
const AD_NETWORK_DOMAINS = [
  'exoclick.com',
  'exosrv.com',
  'juicyads.com',
  'jaavaa.click',
  'trafficjunky.com',
  'trafficjunky.net',
  'eroadvertising.com',
  'popads.net',
  'popcash.net',
  // docs/ROADMAP.md §6.5 — video ad-syndication CDN, seen serving an HLS ad manifest from a
  // `.mp4.m3u8` path with no query string at all (so neither the path-keyword nor macro-template
  // heuristics in junk-url-patterns.ts had anything to match on).
  /* 'tsyndicate.com', */
];

/** True when `url`'s hostname is (or is a subdomain of) a known ad-network domain. Returns `false`
 * (not denylisted) on an unparsable URL rather than throwing — same "graceful, never block on a
 * malformed input" posture as media-url-matcher.ts's `extensionOf`. */
export function isAdNetworkDomain(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return AD_NETWORK_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}
