/**
 * Global SDK (docs/design.md §9): pure, no DOM, no chrome.*, no I/O.
 *
 * docs/ROADMAP.md #5.2 round 2 — the domain denylist (ad-domain-denylist.ts) only knows names it's
 * been told about in advance, so it's blind to a network that rotates domains (DGA-style) or one
 * that just isn't on the built-in list yet. This is a second, independent signal: ad/tracker
 * request URLs tend to share path segments and query-param names regardless of which domain serves
 * them, so a candidate media URL carrying one of these is almost certainly not real media even on
 * an unlisted domain.
 *
 * Matched as whole path segments / whole query-param keys, never substrings — a substring check on
 * `'ads'` would also hit `/uploads/video.mp4`, exactly the false positive this module's Content-Type
 * trust check (docs/ROADMAP.md #4.1) already had to work around once.
 */

const JUNK_PATH_SEGMENTS = [
  'ads',
  'ad',
  'advert',
  'adverts',
  'advertisement',
  'advertising',
  'adserver',
  'adservice',
  'adsystem',
  'analytics',
  'tracking',
  'track',
  'tracker',
  'pixel',
  'beacon',
  'banner',
  'banners',
  'popunder',
];

const JUNK_QUERY_KEYS = [
  'ad_id',
  'adid',
  'ad_unit',
  'click_id',
  'clickid',
  'campaign_id',
  'campaignid',
  'aff_id',
  'affiliate_id',
  'zoneid',
  'zone_id',
  'tracker',
];

/** True when `url`'s path or query string carries an ad/tracker-shaped keyword — a whole path
 * segment or whole query key from the lists above, not a substring match. Returns `false` (not
 * junk) on an unparsable URL rather than throwing, same posture as `isAdNetworkDomain`. */
export function looksLikeAdOrTrackerPath(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const segments = parsed.pathname.toLowerCase().split('/').filter(Boolean);
  if (segments.some((segment) => JUNK_PATH_SEGMENTS.includes(segment))) return true;
  for (const key of parsed.searchParams.keys()) {
    if (JUNK_QUERY_KEYS.includes(key.toLowerCase())) return true;
  }
  return false;
}

/** A query-string value that's still a literal, un-substituted `{macroName}` placeholder — e.g.
 * `cv1={impressionId}`, `cv5={campaignId}`. Ad-tech click-trackers/postback URLs template their
 * redirect/pixel URLs this way (macros get filled in by the ad server at fire time); a real page
 * or media URL essentially never contains a literal, unescaped `{word}` query value. Caught this
 * pattern on a real ad-tracker frame (`t.rallytrck.website/s1/...?cv1={impressionId}&...`) whose
 * domain/path didn't match any of the checks above — the generic `cv1`..`cv10` query KEYS carry no
 * signal on their own, but their VALUES are the macro giveaway. Whole-value match (not substring),
 * same "don't false-positive on a legitimate query value that merely contains a brace" caution as
 * the whole-segment/whole-key matching above. */
export function looksLikeAdMacroTemplate(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  for (const value of parsed.searchParams.values()) {
    if (/^\{[a-zA-Z0-9_]+\}$/.test(value)) return true;
  }
  return false;
}
