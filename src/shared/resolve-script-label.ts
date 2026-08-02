import { slugify } from './slugify';

/**
 * Global SDK (docs/design.md §9): pure string fallback, no chrome/DOM. The 4-tier order chosen at
 * docs/ROADMAP.md §12.0 — user-set name outranks everything else because it's the one signal that
 * is unambiguously deliberate; a uuid is the least useful thing a user could see and is only ever
 * the last resort. Shared by popup + Studio (§12.2) + Side Panel so none of them invents its own
 * fallback chain.
 */
export function resolveScriptLabel(
  id: string,
  // `| undefined` (not just `?`) — this project's `exactOptionalPropertyTypes` requires it since
  // callers pass through already-optional fields (e.g. `ScriptMeta.userLabel`) as explicit
  // `string | undefined` rather than omitting the key.
  opts: { userLabel?: string | undefined; reportLabel?: string | undefined; fileName?: string | undefined },
): string {
  return opts.userLabel || opts.reportLabel || opts.fileName || id;
}

/** Download filename for an uploaded script's source (docs/ROADMAP.md §12.1) — the original
 * filename if one was captured at upload, else a slug of whatever label is currently showing. */
export function resolveScriptFileName(fileName: string | undefined, label: string): string {
  return fileName || `${slugify(label)}.js`;
}
