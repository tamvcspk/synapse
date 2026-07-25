/**
 * Global SDK (docs/design.md §9): pure, environment-agnostic. No DOM, no chrome.*, no I/O — same
 * tier as media-url-matcher.ts.
 *
 * docs/ROADMAP.md #7.2 — MV3 has no `webRequest.filterResponseData` (Firefox-only), so there is no
 * way to read a request's response body as the page issues it. This function is the payload-half of
 * the rescue path for a response Content-Type lies about or omits: the caller does a small, active
 * `Range` probe fetch (network-sniffer/index.ts's `probeMagicBytesKind`, not in this file — that's
 * I/O) and hands the first bytes here to identify the container/manifest format by its leading
 * signature bytes, independent of whatever Content-Type the server sent.
 *
 * Deliberately narrow: identifies a *format*, not a decision about whether to surface it. A format
 * recognized as `'segment'` (MPEG-TS) is a signal that a stream exists at this origin, not something
 * to list — docs/ROADMAP.md #4 already excludes `.ts`/`.m4s` segments from the UI, and that decision
 * doesn't change just because this function can now recognize one by its bytes instead of only by
 * extension/MIME.
 */

import type { MediaKind } from './media-url-matcher';

export type MagicByteKind = MediaKind | 'segment';

function matchesAsciiAt(bytes: Uint8Array, offset: number, ascii: string): boolean {
  if (bytes.length < offset + ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

/** MPEG-TS packets are 188 bytes, each starting with sync byte `0x47` — checking three consecutive
 * packet boundaries (not just offset 0) rules out the far more common case of a payload that merely
 * happens to start with the ASCII letter `G`. */
function isMpegTs(bytes: Uint8Array): boolean {
  return bytes.length >= 377 && bytes[0] === 0x47 && bytes[188] === 0x47 && bytes[376] === 0x47;
}

/** Identifies a media/manifest/segment format from its leading bytes, or `undefined` if none of the
 * known signatures match. `bytes` is expected to be a short prefix of the resource (the caller only
 * probes `Range: bytes=0-1023`) — every check here only ever looks at the first few dozen bytes. */
export function sniffMediaMagicBytes(bytes: Uint8Array): MagicByteKind | undefined {
  if (matchesAsciiAt(bytes, 0, '#EXTM3U')) return 'stream';
  if (isMpegTs(bytes)) return 'segment';
  if (matchesAsciiAt(bytes, 4, 'ftyp')) return 'video'; // MP4/fMP4 ISO base media file format
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video'; // Matroska/WebM (EBML header)
  if (matchesAsciiAt(bytes, 0, 'OggS')) return 'audio';
  if (matchesAsciiAt(bytes, 0, 'RIFF') && matchesAsciiAt(bytes, 8, 'WAVE')) return 'audio';
  if (matchesAsciiAt(bytes, 0, 'ID3')) return 'audio'; // MP3 with an ID3v2 tag prefix
  if (bytes.length >= 2 && bytes[0] === 0xff) {
    const second = bytes[1]!;
    if (second === 0xfb || second === 0xfa || second === 0xf3 || second === 0xf2) return 'audio'; // MP3 frame sync, no ID3 tag
    if (second === 0xf1 || second === 0xf9) return 'audio'; // ADTS AAC frame sync
  }
  return undefined;
}
