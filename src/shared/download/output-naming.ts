import { slugify } from '../slugify';

/**
 * docs/ROADMAP.md §8.5/§11.2 — how a download's saved file gets its name, extracted out of
 * utils/download-engine.ts (Phase 1: "`fileNameFromUrl` → shared/"). Global SDK (docs/design.md §9):
 * pure string work, no `chrome.downloads`.
 */

/** Which container the concatenated OPFS bytes already ARE — decided by whether the manifest carried
 * an `#EXT-X-MAP` init segment (fMP4) or not (MPEG-TS), never by preference. */
export type OutputContainer = 'ts' | 'mp4';

/** The last path segment of a URL, with a trailing `.m3u8` stripped (a manifest's own filename is
 * the best available name for the stream it describes). Empty string for an unparsable URL — the
 * caller supplies its own fallback, since what a good fallback is differs per job kind. */
export function fileNameFromUrl(url: string): string {
  try {
    const { pathname } = new URL(url);
    return pathname.slice(pathname.lastIndexOf('/') + 1).replace(/\.m3u8$/, '');
  } catch {
    return '';
  }
}

/** The final `<name>.<container>` for a manifest-driven job. `slugify`'s `'stream'` fallback covers
 * both an unparsable URL and a URL whose last path segment slugifies away to nothing. */
export function outputFileName(sourceUrl: string, container: OutputContainer): string {
  return `${slugify(fileNameFromUrl(sourceUrl), 'stream')}.${container}`;
}
