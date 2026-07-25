/**
 * Global SDK (docs/design.md §9): pure, no I/O, no DOM — network-sniffer's Inspect action
 * (docs/ROADMAP.md #5.1) and the Merge page's download+remux flow (#5.3) both fetch the manifest
 * text themselves and hand it here.
 *
 * Scope deliberately narrow: HLS (`.m3u8`) only, not DASH (`.mpd`). DASH is XML and would need
 * `DOMParser`, which a service worker (where #5.1's Inspect needs to run, to reuse the `fetch()` +
 * `host_permissions` access background already has) doesn't have. `.m3u8` is plain text.
 */

export interface ManifestVariant {
  url: string;
  /** From `RESOLUTION=WxH` on the variant's `#EXT-X-STREAM-INF` line — absent when the master
   * playlist doesn't advertise one (e.g. audio-only variants). */
  resolution?: string;
}

export type ParsedManifest =
  | { kind: 'master'; variants: ManifestVariant[] }
  | { kind: 'media'; segments: string[]; encrypted: boolean; isLive: boolean }
  | { kind: 'unknown' };

/** The URI line belonging to a tag at `lines[from]` — the next non-blank line, per the HLS spec.
 * Returns `undefined` (not just skips ahead) when that line is itself another `#`-prefixed tag
 * (e.g. an `#EXT-X-KEY` sitting between `#EXTINF` and its segment URI) — leaves `lines[from + 1]`
 * unconsumed so the caller's own loop re-visits it as a tag in its own right, rather than silently
 * discarding it (a real case: a KEY change announced right before the segment it applies to). */
function nextUri(lines: string[], from: number): { value: string; index: number } | undefined {
  for (let j = from + 1; j < lines.length; j++) {
    const candidate = lines[j]!.trim();
    if (!candidate) continue;
    if (candidate.startsWith('#')) return undefined;
    return { value: candidate, index: j };
  }
  return undefined;
}

/**
 * A master playlist (`#EXT-X-STREAM-INF` lines) lists one variant per resolution, itself another
 * manifest URL — not a video. A media/variant playlist (`#EXTINF` lines, no `#EXT-X-STREAM-INF`)
 * lists that one resolution's segment URLs — also not a video on its own, hence #5.3's
 * download-every-segment-then-remux flow, which is what `segments` feeds. `encrypted` (a
 * `#EXT-X-KEY:METHOD=...` other than `NONE`, e.g. Widevine/EME) is the DRM guard #5.3 refuses to
 * proceed past. Malformed/unresolvable URIs are skipped individually, not treated as a
 * whole-manifest parse failure — same "partial result over hard failure" posture as
 * fetch-images'/crawlSite's per-item skip.
 *
 * docs/ROADMAP.md #7.4 — `isLive` (media playlists only) is `true` unless `#EXT-X-ENDLIST` is
 * present, OR `#EXT-X-PLAYLIST-TYPE:EVENT` is present (an EVENT playlist only ever appends segments
 * until its own ENDLIST shows up — treated as still-live here too, conservatively). This is the
 * safety gate the Merge page's segment-URL-expired recovery (ui/merge/main.ts) checks before ever
 * remapping segments by index after a manifest refetch: a live playlist's window slides, so an index
 * from an old fetch no longer names the same segment in a new one.
 */
export function parseM3u8(text: string, baseUrl: string): ParsedManifest {
  const lines = text.split(/\r?\n/);
  const variants: ManifestVariant[] = [];
  const segments: string[] = [];
  let encrypted = false;
  let isMaster = false;
  let isMedia = false;
  let hasEndList = false;
  let playlistType: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      isMaster = true;
      const resolution = line.match(/RESOLUTION=(\d+x\d+)/)?.[1];
      const uri = nextUri(lines, i);
      if (uri) {
        i = uri.index;
        try {
          const url = new URL(uri.value, baseUrl).toString();
          variants.push(resolution ? { url, resolution } : { url });
        } catch {
          // Malformed URI — skip this variant, keep parsing the rest of the master playlist.
        }
      }
      continue;
    }

    if (line.startsWith('#EXTINF')) {
      isMedia = true;
      const uri = nextUri(lines, i);
      if (uri) {
        i = uri.index;
        try {
          segments.push(new URL(uri.value, baseUrl).toString());
        } catch {
          // Malformed URI — skip this segment, keep parsing the rest of the playlist.
        }
      }
      continue;
    }

    if (line.startsWith('#EXT-X-KEY')) {
      const method = line.match(/METHOD=([^,]+)/)?.[1];
      if (method && method !== 'NONE') encrypted = true;
      continue;
    }

    if (line.startsWith('#EXT-X-ENDLIST')) {
      hasEndList = true;
      continue;
    }

    if (line.startsWith('#EXT-X-PLAYLIST-TYPE')) {
      playlistType = line.split(':')[1]?.trim();
    }
  }

  if (isMaster) return { kind: 'master', variants };
  if (isMedia) return { kind: 'media', segments, encrypted, isLive: !hasEndList || playlistType === 'EVENT' };
  return { kind: 'unknown' };
}
