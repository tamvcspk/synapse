/**
 * Global SDK (docs/design.md §9): pure, no DOM, no chrome.*, no I/O — same tier as
 * junk-url-patterns.ts/media-url-matcher.ts.
 *
 * docs/ROADMAP.md #7.4 — a LABEL, not a filter, same reasoning as `DetectedMedia.thirdParty`'s doc
 * comment: a legitimate video URL being signed/time-limited is completely normal (most CDN media
 * is), so this is never used to exclude anything — only to warn the user the link will expire.
 */

// Query-param KEYS commonly used by signed/expiring media links (S3/CloudFront presigned URLs, CDN
// token-auth, etc.) — matched case-insensitively by key name only. Unlike junk-url-patterns.ts's
// macro-template check, there's no distinctive VALUE shape to key off of here (an expiry timestamp
// or a signature hash both just look like arbitrary opaque strings) — the key name itself is the
// only signal available.
const SIGNED_URL_QUERY_KEYS = [
  'expires',
  'expire',
  'e',
  'st',
  'token',
  'sig',
  'signature',
  'hmac',
  'hash',
  'key',
  'policy',
  'x-amz-signature',
  'x-amz-expires',
];

/** True when `url`'s query string carries a key from the list above. Returns `false` (not signed) on
 * an unparsable URL rather than throwing, same posture as `isAdNetworkDomain`/`looksLikeAdOrTrackerPath`. */
export function looksLikeSignedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  for (const key of parsed.searchParams.keys()) {
    if (SIGNED_URL_QUERY_KEYS.includes(key.toLowerCase())) return true;
  }
  return false;
}
