/**
 * Enumerates ./mock-files/* at BUILD time (Chrome extensions have no runtime API to list their own
 * packaged files — `import.meta.glob` is the only way to know what's in there) so the Dashboard
 * form can offer them as `rewriteUrl` suggestions (docs/ROADMAP.md #2.6) — redirect a request to a
 * bundled sample file instead of typing a URL by hand. Drop a file into mock-files/ and rebuild;
 * this file needs no changes when the file list changes.
 */

// `?url` makes Vite treat each match as a plain asset rather than parsing its contents — the
// imported value is a *string*, but which kind of string depends on the file's size: one under
// `build.assetsInlineLimit` (~4KB) comes back as an already-absolute `data:` URI (Vite inlines it
// instead of emitting a file at all); a bigger one comes back as a root-relative path
// (`/assets/<name>-<hash><ext>`) pointing at a real emitted file — verified against this project's
// actual build output, not just assumed from Vite's docs.
const files = import.meta.glob('./mock-files/*', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export interface MockFile {
  fileName: string;
  /** Absolute URL, ready to use as a redirect target from any page — either the `data:` URI
   * passthrough above, or `chrome.runtime.getURL()` applied to the root-relative path (that
   * conversion has to happen somewhere with chrome.* access; this module already has it, being
   * bundled straight into the background service worker like everything importing it). A bare
   * root-relative path would resolve against *that page's own* origin, not the extension's, which
   * is why it can't be handed to a redirect target as-is. */
  url: string;
}

export const MOCK_FILES: MockFile[] = Object.entries(files)
  .map(([globPath, path]) => ({
    fileName: globPath.replace('./mock-files/', ''),
    url: path.startsWith('data:') ? path : chrome.runtime.getURL(path),
  }))
  .sort((a, b) => a.fileName.localeCompare(b.fileName));
