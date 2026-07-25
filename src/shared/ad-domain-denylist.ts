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
  'tsyndicate.com',
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

// docs/ROADMAP.md #7.5 — a DIFFERENT shape of signal than AD_NETWORK_DOMAINS above: not a specific
// known domain, but a hostname LABEL commonly used across many unrelated ad/tracking operators
// (`creative.example.com`, `ads.example.net`, ...) regardless of which registrable domain it's on.
// Kept as its own list/function rather than folded into `isAdNetworkDomain` — that one is an exact/
// subdomain match against domains this module already knows by name; this one only ever looks at the
// FIRST label of the hostname and matches on any domain, known or not.
const AD_HOSTNAME_PREFIXES = ['creative.', 'ads.', 'adserver.', 'track.', 'pixel.'];

/** True when `url`'s hostname itself STARTS WITH one of the ad/tracker-shaped labels above (e.g.
 * `creative.somecdn.com`) — distinct from `isAdNetworkDomain`'s exact/subdomain match against known
 * domains. Returns `false` on an unparsable URL, same posture as `isAdNetworkDomain`. */
export function looksLikeAdHostnamePrefix(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return AD_HOSTNAME_PREFIXES.some((prefix) => hostname.startsWith(prefix));
}
