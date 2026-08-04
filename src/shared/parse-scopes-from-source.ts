/**
 * Best-effort static extraction of a script's declared `scopes` array from its raw source text —
 * used ONLY before a script's first `ManifestReport` exists (docs/ROADMAP.md §12.4), so the popup's
 * Grant button doesn't need an actual page run + reload just to learn what a freshly-saved script is
 * asking for. No AST, same "cheap and durable, not exact" posture as `ui/studio/main.ts`'s
 * `parseStepsFromSource` — a `scopes` value built any other way (e.g. `scopes: buildScopes()`)
 * simply won't be found here, which is fine: `chrome-module-registry.ts` only calls this in the
 * `!report` branch, and the real `ManifestReport`, once it exists, always wins over this.
 *
 * Output feeds straight into `normalizeScopeGrants` (kernel/scopes.ts) — this only extracts the raw
 * shape (a bare string or a `{scope, match}` object literal); every scope-name/match-pattern
 * validation rule stays there, shared with the real runtime path instead of duplicated here.
 */
export function parseScopesFromSource(source: string): unknown[] {
  const arrayMatch = /\bscopes\s*:\s*\[/.exec(source);
  if (!arrayMatch) return [];

  const body = extractBracketBody(source, arrayMatch.index + arrayMatch[0].length);
  if (body === undefined) return [];

  return splitTopLevel(body)
    .map((entry) => parseOneEntry(entry.trim()))
    .filter((entry) => entry !== undefined);
}

/** `start` points just past the opening `[` this array's own match already consumed. */
function extractBracketBody(source: string, start: number): string | undefined {
  let depth = 1;
  let i = start;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']') depth--;
  }
  return depth === 0 ? source.slice(start, i - 1) : undefined;
}

/** Splits a comma-separated list at TOP LEVEL only — respects nested `{}`/`[]` and quoted strings,
 * so a `match: ['a,b']` value or a nested object never gets split on an internal comma. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === quote && body[i - 1] !== '\\') quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  const last = body.slice(start);
  if (last.trim()) parts.push(last);
  return parts;
}

function parseOneEntry(entry: string): unknown {
  const quoted = /^(['"`])((?:(?!\1).)*)\1$/.exec(entry);
  if (quoted) return quoted[2];
  if (!entry.startsWith('{')) return undefined;

  const scopeMatch = /\bscope\s*:\s*(['"`])((?:(?!\1).)*?)\1/.exec(entry);
  if (!scopeMatch) return undefined;

  const matchArrayMatch = /\bmatch\s*:\s*\[([^\]]*)\]/.exec(entry);
  const match = matchArrayMatch
    ? Array.from((matchArrayMatch[1] ?? '').matchAll(/(['"`])((?:(?!\1).)*?)\1/g)).map((m) => m[2] ?? '')
    : undefined;

  return match ? { scope: scopeMatch[2], match } : { scope: scopeMatch[2] };
}
