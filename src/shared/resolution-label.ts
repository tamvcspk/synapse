/**
 * Maps an HLS variant's `RESOLUTION=WxH` attribute to a familiar quality-tier name (SD/HD/Full HD/
 * QHD/4K) — a resolution picker showing bare pixel dimensions ("1920x1080") makes a casual user do
 * the WxH-to-quality translation themselves; every mainstream video site's quality picker already
 * does this translation for them. Global SDK (§9): pure string-in/string-out, no chrome.* or DOM,
 * shared by network-sniffer's Dashboard `variantLinks` (background) and the Side Panel's resolution
 * `<select>` (extension page) — the same label should read identically in both places.
 */
export function qualityTier(resolution: string | undefined): string | undefined {
  if (!resolution) return undefined;
  const match = /^(\d+)x(\d+)$/.exec(resolution.trim());
  if (!match) return undefined;
  const height = Number(match[2]);
  if (!Number.isFinite(height)) return undefined;
  if (height <= 480) return 'SD';
  if (height <= 720) return 'HD';
  if (height <= 1080) return 'Full HD';
  if (height <= 1440) return 'QHD';
  return '4K';
}

/** `"1920x1080 (Full HD)"` — falls back to the bare resolution string, or to `fallback` (e.g.
 * `"Variant 2"`) when there's no resolution to work with at all (a variant whose manifest never had
 * an `EXT-X-STREAM-INF` bandwidth/resolution tag). */
export function describeResolution(resolution: string | undefined, fallback: string): string {
  if (!resolution) return fallback;
  const tier = qualityTier(resolution);
  return tier ? `${resolution} (${tier})` : resolution;
}
