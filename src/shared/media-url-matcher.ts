/**
 * Global SDK (docs/design.md §9): pure, environment-agnostic. No DOM, no chrome.*, no I/O — must
 * survive being imported anywhere, including a MAIN-world payload.
 *
 * Policy half of the Network Sniffer's mechanism/policy split (docs/ROADMAP.md #4) — the mechanism
 * (utils/webrequest-media-observer.ts) knows nothing about what counts as "media", it just reports
 * every observed request URL to this matcher.
 */

export type MediaKind = 'video' | 'audio' | 'stream';

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mkv', 'mov', 'avi'];
const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'wav', 'ogg', 'flac'];
// Manifest/playlist formats, not the media bytes themselves — still useful to surface (an m3u8 at
// least tells the user a stream exists there), but see the deliberate exclusion below.
const STREAM_EXTENSIONS = ['m3u8', 'mpd'];

// Deliberately NOT matched: HLS/DASH segment/fragment extensions ('ts', 'm4s'). A single stream can
// fire hundreds of these — surfacing the manifest is useful, surfacing every segment is spam and
// none of them are independently downloadable/useful on their own (docs/ROADMAP.md #4).

function extensionOf(url: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dotIndex = lastSegment.lastIndexOf('.');
  if (dotIndex === -1) return undefined;
  return lastSegment.slice(dotIndex + 1).toLowerCase();
}

/** Classifies a request URL as media by its file extension, or `undefined` if it isn't one this
 * Module cares about. Extension-only (no content-type sniffing) — see the Network Sniffer's
 * documented v1 scope cuts (docs/ROADMAP.md #4). */
export function classifyMediaUrl(url: string): MediaKind | undefined {
  const extension = extensionOf(url);
  if (!extension) return undefined;
  if (VIDEO_EXTENSIONS.includes(extension)) return 'video';
  if (AUDIO_EXTENSIONS.includes(extension)) return 'audio';
  if (STREAM_EXTENSIONS.includes(extension)) return 'stream';
  return undefined;
}
