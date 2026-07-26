/**
 * Global SDK (docs/design.md §9): pure, no I/O, no DOM — network-sniffer's Inspect action
 * (docs/ROADMAP.md #5.1) and the Merge page's download+remux flow (#5.3/#8.4) both fetch the
 * manifest text themselves and hand it here.
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

/**
 * docs/ROADMAP.md #8.4 — one `#EXT-X-KEY` tag's worth of info, attached to every segment it
 * applies to (HLS keys apply to all subsequent segments until the next `#EXT-X-KEY` tag, so the
 * SAME `SegmentKey` object is shared across a run of segments, not re-parsed per segment).
 *
 * **The method/keyFormat distinction here is a hard security boundary, not a UI nicety:**
 * - `method: 'AES-128'` with no `keyFormat` (or `keyFormat: 'identity'`) is plain segment
 *   encryption whose key is served in the CLEAR at `uri` — no access control system involved.
 *   ffmpeg/VLC/hls.js all play this like any other HLS stream. This is the case #8.4 decrypts.
 * - `method: 'SAMPLE-AES'`, or any `keyFormat` other than `'identity'` (e.g.
 *   `urn:uuid:edef8ba9-...` = Widevine, `com.microsoft.playready` = PlayReady, `skd://` = FairPlay)
 *   is real DRM. Synapse refuses these outright (see the Merge page's guard) — do not add a path
 *   that decodes or bypasses them.
 */
export interface SegmentKey {
  method: string;
  /** Absolute URL of the key file (raw 16-byte key for `AES-128`). */
  uri: string;
  /** Raw `IV=0x...` attribute text, if present — absent means the engine must derive the IV from
   * the segment's media sequence number per the HLS spec (see the decrypt engine, #8.4). */
  iv?: string;
  /** Absent is equivalent to `'identity'` per the HLS spec — both mean "not DRM" for the guard
   * above. Kept as the raw attribute value (not defaulted here) so the guard can log what it saw. */
  keyFormat?: string;
}

export interface ManifestSegment {
  url: string;
  /** `undefined` = unencrypted (no `#EXT-X-KEY` in scope, or the most recent one was `METHOD=NONE`). */
  key?: SegmentKey;
  /** Raw `BYTERANGE` attribute text (`<length>[@<offset>]`) when this is a slice of a larger file
   * rather than a whole one — only ever set for an `#EXT-X-MAP` init segment here (the standalone
   * `#EXT-X-BYTERANGE` tag that can precede a media segment is still unhandled). */
  byteRange?: string;
}

export type ParsedManifest =
  | { kind: 'master'; variants: ManifestVariant[] }
  | {
      kind: 'media';
      segments: ManifestSegment[];
      /**
       * From `#EXT-X-MAP:URI="..."` — the initialization segment of a FRAGMENTED-MP4 (CMAF) stream,
       * and the single most important thing to get right about this manifest shape. Where MPEG-TS
       * segments are self-describing (every `.ts` segment carries its own PAT/PMT, which is why
       * concatenating them alone yields a playable file), fMP4 media segments are bare
       * `moof`+`mdat` fragments: ALL the codec/track metadata lives in the `ftyp`+`moov` boxes of
       * this one init segment. Concatenating the media segments without prepending it produces a
       * file with no `moov` box at all — not a degraded file, an undemuxable one, which ffmpeg
       * rejects outright (exit code 1) rather than diagnosing.
       *
       * `undefined` for the MPEG-TS case (no `#EXT-X-MAP` tag), which is also the correct signal
       * that concatenated output should be named `.ts` rather than `.mp4`.
       */
      initSegment?: ManifestSegment;
      encrypted: boolean;
      isLive: boolean;
      /** From `#EXT-X-MEDIA-SEQUENCE:N` (0 when absent, the HLS-spec default) — `segments[i]`'s own
       * sequence number is `mediaSequence + i`. docs/ROADMAP.md #8.4's AES-128 decrypt engine needs
       * this to derive a segment's IV when its `SegmentKey` doesn't carry an explicit `IV=` attribute. */
      mediaSequence: number;
    }
  | { kind: 'unknown' };

/** Parses a tag's `KEY=value,KEY="quoted, value",...` attribute list (the format `#EXT-X-KEY`,
 * `#EXT-X-STREAM-INF`, etc. all share) into a plain map. Quoted values may contain commas (e.g. a
 * `URI` with query params); unquoted ones stop at the next comma. */
function parseAttributeList(tagBody: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(tagBody))) {
    attrs[match[1]!] = match[2] ?? match[3] ?? '';
  }
  return attrs;
}

/**
 * A master playlist (`#EXT-X-STREAM-INF` lines) lists one variant per resolution, itself another
 * manifest URL — not a video. A media/variant playlist (`#EXTINF` lines, no `#EXT-X-STREAM-INF`)
 * lists that one resolution's segment URLs — also not a video on its own, hence #5.3's
 * download-every-segment-then-remux flow, which is what `segments` feeds. `encrypted` (derived: at
 * least one segment carries a `key`) is a UI label, not a hard gate by itself anymore (docs/
 * ROADMAP.md #8.4) — the real DRM-vs-plain-AES-128 distinction lives on each segment's `key` (see
 * `SegmentKey`'s doc comment) and is enforced where segments are actually downloaded, not here.
 * Malformed/unresolvable URIs are skipped individually, not treated as a whole-manifest parse
 * failure — same "partial result over hard failure" posture as fetch-images'/crawlSite's per-item
 * skip.
 *
 * Tag lines between an `#EXTINF`/`#EXT-X-STREAM-INF` and the bare URI line they apply to (e.g. an
 * `#EXT-X-KEY` announcing a key change right before the segment it applies to, or `#EXT-X-
 * DISCONTINUITY`/`#EXT-X-BYTERANGE`) are handled generically: this parser tracks "the next bare
 * line belongs to whichever tag most recently asked for one" rather than requiring the URI to be
 * the line immediately following its tag, so any number of intervening tags a Type-3/4 playlist
 * throws in don't lose the segment.
 *
 * docs/ROADMAP.md #7.4 — `isLive` (media playlists only) is `true` unless `#EXT-X-ENDLIST` is
 * present, OR `#EXT-X-PLAYLIST-TYPE:EVENT` is present (an EVENT playlist only ever appends segments
 * until its own ENDLIST shows up — treated as still-live here too, conservatively). This is the
 * safety gate the download engine's segment-URL-expired recovery (utils/download-engine.ts, moved
 * off `ui/merge/main.ts` by docs/ROADMAP.md §8.1) checks before ever remapping segments by index
 * after a manifest refetch: a live playlist's window slides, so an index from an old fetch no longer
 * names the same segment in a new one.
 */
export function parseM3u8(text: string, baseUrl: string): ParsedManifest {
  const lines = text.split(/\r?\n/);
  const variants: ManifestVariant[] = [];
  const segments: ManifestSegment[] = [];
  let isMaster = false;
  let isMedia = false;
  let hasEndList = false;
  let playlistType: string | undefined;
  let mediaSequence = 0;
  let currentKey: SegmentKey | undefined;
  let initSegment: ManifestSegment | undefined;
  let pendingVariantResolution: string | undefined;
  let awaitingVariantUri = false;
  let awaitingSegmentUri = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (!line.startsWith('#')) {
      // A bare URI line — belongs to whichever tag most recently signaled it needs one (which may
      // be several lines back, past intervening tags this parser doesn't otherwise act on).
      if (awaitingVariantUri) {
        awaitingVariantUri = false;
        try {
          const url = new URL(line, baseUrl).toString();
          variants.push(pendingVariantResolution ? { url, resolution: pendingVariantResolution } : { url });
        } catch {
          // Malformed URI — skip this variant, keep parsing the rest of the master playlist.
        }
        pendingVariantResolution = undefined;
      } else if (awaitingSegmentUri) {
        awaitingSegmentUri = false;
        try {
          const url = new URL(line, baseUrl).toString();
          segments.push(currentKey ? { url, key: currentKey } : { url });
        } catch {
          // Malformed URI — skip this segment, keep parsing the rest of the playlist.
        }
      }
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      isMaster = true;
      pendingVariantResolution = line.match(/RESOLUTION=(\d+x\d+)/)?.[1];
      awaitingVariantUri = true;
      continue;
    }

    if (line.startsWith('#EXTINF')) {
      isMedia = true;
      awaitingSegmentUri = true;
      continue;
    }

    if (line.startsWith('#EXT-X-KEY')) {
      const attrs = parseAttributeList(line.slice(line.indexOf(':') + 1));
      if (!attrs.METHOD || attrs.METHOD === 'NONE' || !attrs.URI) {
        currentKey = undefined;
      } else {
        try {
          currentKey = {
            method: attrs.METHOD,
            uri: new URL(attrs.URI, baseUrl).toString(),
            ...(attrs.IV !== undefined ? { iv: attrs.IV } : {}),
            ...(attrs.KEYFORMAT !== undefined ? { keyFormat: attrs.KEYFORMAT } : {}),
          };
        } catch {
          currentKey = undefined;
        }
      }
      continue;
    }

    if (line.startsWith('#EXT-X-MAP')) {
      // Only ever appears in a media playlist, so it's a positive `isMedia` signal in its own right
      // (a playlist whose #EXTINF lines this parser somehow missed still classifies correctly).
      isMedia = true;
      const attrs = parseAttributeList(line.slice(line.indexOf(':') + 1));
      if (attrs.URI) {
        try {
          initSegment = {
            url: new URL(attrs.URI, baseUrl).toString(),
            // Per the HLS spec an init segment is covered by whatever #EXT-X-KEY is in scope at the
            // point the tag appears — in practice it precedes any key change, so this is almost
            // always `undefined` even on an encrypted stream.
            ...(currentKey ? { key: currentKey } : {}),
            ...(attrs.BYTERANGE !== undefined ? { byteRange: attrs.BYTERANGE } : {}),
          };
        } catch {
          // Malformed URI — leave initSegment unset; the download path reports the resulting
          // missing-init failure far more usefully than a whole-manifest parse failure would.
        }
      }
      continue;
    }

    if (line.startsWith('#EXT-X-ENDLIST')) {
      hasEndList = true;
      continue;
    }

    if (line.startsWith('#EXT-X-PLAYLIST-TYPE')) {
      playlistType = line.split(':')[1]?.trim();
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      const n = parseInt(line.split(':')[1] ?? '', 10);
      if (!Number.isNaN(n)) mediaSequence = n;
      continue;
    }
  }

  if (isMaster) return { kind: 'master', variants };
  if (isMedia) {
    return {
      kind: 'media',
      segments,
      ...(initSegment ? { initSegment } : {}),
      encrypted: segments.some((s) => s.key !== undefined),
      isLive: !hasEndList || playlistType === 'EVENT',
      mediaSequence,
    };
  }
  return { kind: 'unknown' };
}
