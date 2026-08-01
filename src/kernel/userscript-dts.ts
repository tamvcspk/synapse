import { API_METHODS, ALL_SCOPES, SCOPE_CATALOG } from './scopes';

/**
 * Generator for `docs/types/synapse-userscript.d.ts` — the types a user script author references
 * in their editor (docs/ROADMAP.md §11.3).
 *
 * Generated, never hand-maintained, for one reason: **drift is dangerous here**. Most scripts will
 * be written with an AI assistant, and stale types produce confidently wrong code the author has no
 * way to diagnose. Hand-written docs fall behind `synapse-api.ts` within weeks; a generator plus the
 * snapshot assertion in `userscript-dts.test.ts` makes that impossible — change the interface
 * without regenerating and the test suite fails.
 *
 * This is the first of the three outputs the same source will feed (Phase 5 adds the in-extension
 * Help page and the downloadable AI-context bundle, §11.6). Nothing here is bundled into the
 * extension: only the test imports it.
 *
 * Not part of the shipped runtime and not a build step — run `npm test -- -u` to regenerate.
 */

const BEGIN_MARKER = '/* @userscript-dts:begin';

export function buildUserscriptDts(apiSource: string): string {
  return [header(), scopeReference(), declarations(apiSource), globals()].join('\n');
}

function header(): string {
  return `/**
 * Types for writing a Synapse user script — GENERATED from src/kernel/synapse-api.ts and
 * src/kernel/scopes.ts. Do not edit by hand: regenerate with \`npm test -- -u\`.
 *
 * Reference this file in your own editor for autocomplete. It has no effect on the extension build
 * (it lives outside src/, which is all tsconfig.json includes) and is never imported at runtime:
 * \`synapseApi\` and \`__synapseModule\` are plain globals the extension injects around your code.
 * See docs/user-scripts.md for the authoring convention.
 */
`;
}

/** The scope catalog rendered as a doc comment, so an author (or an assistant reading this file)
 * sees what each permission means and — critically — which ones refusing actually blocks. */
function scopeReference(): string {
  const lines: string[] = ['/**', ' * ## Scopes', ' *'];

  for (const enforcement of ['enforced', 'disclosed'] as const) {
    const scopes = ALL_SCOPES.filter((s) => SCOPE_CATALOG[s].enforcement === enforcement);
    if (scopes.length === 0) continue;

    lines.push(
      enforcement === 'enforced'
        ? ' * ### Enforced — the call fails if the user denies it'
        : ' * ### Disclosed — the script can do this anyway; declaring it is transparency, not a gate',
      ' *',
    );
    for (const scope of scopes) {
      const def = SCOPE_CATALOG[scope];
      lines.push(` * - \`${scope}\` — ${def.consentLine}.`);
      for (const line of wrap(def.description, 92)) lines.push(` *   ${line}`);
      if (def.requiresMatch) lines.push(' *   Requires a `match` list: `{ scope, match: [...] }`.');
    }
    lines.push(' *');
  }

  lines.push(' * ## Methods', ' *');
  for (const method of API_METHODS) {
    // Whether a call leaves the page matters to an author: in-world methods are synchronous and
    // take callbacks, RPC ones are async and drop every function they are handed.
    const note = method.transport === 'in-world' ? ' (runs in your own world — synchronous)' : '';
    lines.push(` * - \`synapseApi.${method.namespace}.${method.signature}\` — requires \`${method.scope}\`${note}.`);
    for (const line of wrap(method.description, 92)) lines.push(` *   ${line}`);
  }
  lines.push(' */');

  return `${lines.join('\n')}\n`;
}

/** The interface declarations, copied verbatim from the single source of truth. `export` is
 * stripped because a `.d.ts` with an export becomes a module, which would stop these types being
 * ambient globals — exactly what a script author needs them to be. */
function declarations(apiSource: string): string {
  const start = apiSource.indexOf(BEGIN_MARKER);
  if (start === -1) {
    throw new Error(`synapse-api.ts is missing the "${BEGIN_MARKER}" marker`);
  }
  const afterMarker = apiSource.slice(apiSource.indexOf('\n', start) + 1);
  return afterMarker.replace(/^export /gm, '').trim();
}

function globals(): string {
  return `
/**
 * Assign this to declare your script. \`scopes\` is a *request*: the extension re-checks the grant
 * the user approved on every call, so a scope you declared but the user denied fails at the call,
 * not at load.
 *
 * The API arrives as \`run()\`'s \`ctx.api\` — there is deliberately **no** \`synapseApi\` global.
 * Every uploaded script shares one execution world, so a global has a single binding for all of
 * them and cannot tell the platform which script is calling; the last script loaded would own the
 * name and everyone else's calls would run under its identity and its permissions. To use the API
 * outside \`run()\`, capture it: \`let api; …async run(input, ctx) { api = ctx.api; }\`.
 * (The name \`synapseApi\` does exist in that world, but every method on it rejects with this
 * explanation — a loud failure instead of a silent impersonation.)
 */
declare let __synapseModule: SynapseUserScriptManifest;
`;
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length > 0 && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current.length > 0 ? `${current} ${word}` : word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}
