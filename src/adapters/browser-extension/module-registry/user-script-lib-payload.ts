import type { SynapseLibApi } from '../../../kernel/synapse-api';
import { htmlToMarkdown } from '../../../shared/html-to-markdown';
import { isValidMatchPattern, matchesAnyPattern, matchesUrlPattern } from '../../../shared/match-pattern';
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
 * Zero chrome.*, zero privilege: `parseM3u8`/`htmlToMarkdown`/`buildZip`/match-pattern's matcher are pure (`shared/`,
 * docs/design.md §9's Global SDK — "survives the strictest execution context", which the
 * USER_SCRIPT world literally is), and `Readability` only ever touches the `Document` it's
 * explicitly handed, never a module-scope global. This is the entire reason `lib.*` needs no scope
 * and no RPC round trip (docs/api-inventory.md §3.0) — the script already has everything this needs
 * in hand. `readable`/`toMarkdown` are meaningful only where a page DOM exists (same as `ui`), but
 * unlike `ui` they get no crafted "unavailable" stub outside one: calling `readable()` with no `doc`
 * where there is no `document` global fails with a plain `ReferenceError` — an honest failure for a
 * missing input, not a privilege being denied.
 *
 * The one externally-visible effect is this global assignment. `user-script-shim.ts` captures it —
 * but, unlike `__synapseModule`, does NOT delete it afterward: `lib` is pure and script-agnostic (no
 * moduleId, no caller identity, nothing that would leak by being read twice), so it is safe, and
 * REQUIRED for correctness, for two scripts sharing this exact `{file}` resource to both read the
 * same value. Found on real Chrome with 2 scripts active on one page: Chrome does not guarantee
 * re-running this file once per registered script that lists it, so a delete-after-capture design
 * left the second script's `ctx.api.lib` `undefined` whenever an earlier script's shim had already
 * deleted the global first. See `user-script-shim.ts`'s own doc comment at the capture site for the
 * full write-up.
 */
// Typed against `SynapseLibApi` (unlike the `unknown` cast on the global below) so a namespace
// added to that interface and forgotten HERE is a compile error, not a silent runtime gap — the
// exact class of bug `media` hit in `user-script-shim.ts` (docs/LESSONS.md), except this file is
// real TypeScript rather than a hand-written string template, so the type system can actually catch
// it once the object is annotated.
const lib: SynapseLibApi = {
  hls: { parse: parseM3u8 },
  readable,
  toMarkdown: htmlToMarkdown,
  zip: buildZip,
  matchPattern: { isValid: isValidMatchPattern, test: matchesUrlPattern, testAny: matchesAnyPattern },
};
(globalThis as { __synapseLib?: unknown }).__synapseLib = lib;
