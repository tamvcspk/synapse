import { htmlToMarkdown } from '../../../shared/html-to-markdown';
import { parseM3u8 } from '../../../shared/media-manifest-parser';
import { buildZip } from '../../../shared/zip';
import { readable } from './lib-readable';

/**
 * `synapseApi.lib`'s first payload (docs/api-inventory.md §3.0's "static inject" spike, §6 item 3).
 * Built via the `?script&iife` resource import (same mechanism/reason as
 * `features/media/main-world-payload.page.ts` — a plain, ESM-free bundle, because the USER_SCRIPT
 * world has no module loader) into a standalone file, then registered as a PLAIN `{ file: ... }`
 * entry in `chrome.userScripts.register`'s `js` array — `chrome-module-registry.ts` lists it
 * BEFORE the script's own shimmed `{ code }` entry for every uploaded script, exactly like
 * `content_scripts.js` arrays: Chrome runs listed entries in order, in one execution, so this file's
 * global assignment below is guaranteed to have already happened by the time the shim's own header
 * runs. No runtime fetch, no threading a payload string through `buildShimSource` — `chrome.userScripts`
 * accepts a `file` path directly (`ScriptSource.file`), same as `content_scripts` always has.
 *
 * Zero chrome.*, zero privilege: `parseM3u8`/`htmlToMarkdown`/`buildZip` are pure (`shared/`,
 * docs/design.md §9's Global SDK — "survives the strictest execution context", which the
 * USER_SCRIPT world literally is), and `Readability` only ever touches the `Document` it's
 * explicitly handed, never a module-scope global. This is the entire reason `lib.*` needs no scope
 * and no RPC round trip (docs/api-inventory.md §3.0) — the script already has everything this needs
 * in hand. `readable`/`toMarkdown` are meaningful only where a page DOM exists (same as `ui`), but
 * unlike `ui` they get no crafted "unavailable" stub outside one: calling `readable()` with no `doc`
 * where there is no `document` global fails with a plain `ReferenceError` — an honest failure for a
 * missing input, not a privilege being denied.
 *
 * The one externally-visible effect is this global assignment. `user-script-shim.ts` captures and
 * immediately deletes it, the same pattern already used for `__synapseModule` — necessary because
 * EVERY uploaded script's own registration lists this same file, so on a page running several
 * scripts it runs once per script; each run must hand its result to only the script that triggered
 * it, never leak into the shared USER_SCRIPT world past that point.
 */
(globalThis as { __synapseLib?: unknown }).__synapseLib = {
  hls: { parse: parseM3u8 },
  readable,
  toMarkdown: htmlToMarkdown,
  zip: buildZip,
};
