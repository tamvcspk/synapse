import type { SynapseApi, SynapseScope, SynapseScopeGrant } from './synapse-api';

/**
 * The scope catalog (docs/ROADMAP.md §11.3, `.claude/skills/userscript-api`) — the data behind
 * both halves of the permission model: what the consent UI shows a user, and what
 * `module-registry/rpc-handler.ts` re-checks on every call.
 *
 * Two rules this file exists to enforce structurally:
 *
 * - **Every scope and every method carries a human-readable `description` from day one**
 *   (§11.3 constraint E). The consent UI needs one anyway, so this catalog is also the source the
 *   generated docs are built from (`userscript-dts.ts` today, the Help page + AI bundle in Phase 5).
 *   Retrofitting descriptions onto ~40 methods later is the cost this avoids.
 * - **Enforced and Disclosed are separate classes and must never be merged in a UI**
 *   (§11.3 constraint C). Denying a Disclosed scope protects nobody — a script sharing the page's
 *   DOM can call `document.querySelector` with zero permission from Synapse — so presenting it
 *   next to a real gate is a consent UI that lies.
 *
 * `~10 scopes is the ceiling`: past that, users click Allow on everything and the model collapses.
 */

export type ScopeEnforcement =
  /** The only way to do this is through `synapseApi` — refusing it actually closes a gate. */
  | 'enforced'
  /** The script can do this anyway. Declaring it is transparency, not a gate. */
  | 'disclosed';

export interface ScopeDefinition {
  scope: SynapseScope;
  enforcement: ScopeEnforcement;
  /** One line, written for the consent prompt — a technical user must be able to reason about it.
   * If a one-liner can't be written, the scope is too broad and should be split. `{domains}` is
   * substituted with the grant's `match` patterns (see `requiresMatch`). */
  consentLine: string;
  /** Longer explanation, for generated docs. */
  description: string;
  /** Whether a grant of this scope is meaningless without a resource dimension (§11.3 constraint
   * B). No scope needs it yet; the network-touching scopes of Phase 5 will. */
  requiresMatch: boolean;
}

export const SCOPE_CATALOG: Record<SynapseScope, ScopeDefinition> = {
  'storage.rw': {
    scope: 'storage.rw',
    enforcement: 'enforced',
    consentLine: "Store this script's own data",
    description:
      'Read and write a key/value store private to this script. Keys are namespaced by the ' +
      'platform: this script cannot see another script\'s data, nor the extension\'s own settings.',
    requiresMatch: false,
  },
  'page.dom': {
    scope: 'page.dom',
    enforcement: 'disclosed',
    consentLine: 'Read and modify the content of pages it runs on',
    description:
      'The script reads or changes the page it is injected into. Disclosed, not enforced: a script ' +
      'running on the page already shares its DOM, so `document.querySelector` works whether or not ' +
      'this is granted. It becomes genuinely enforced only for scripts hosted in a sandboxed frame ' +
      '(docs/ROADMAP.md §11.8), which have no page DOM at all.',
    requiresMatch: false,
  },
  'ui.render': {
    scope: 'ui.render',
    enforcement: 'disclosed',
    consentLine: 'Show toasts, icons and badges on pages it runs on',
    description:
      "Draw into Synapse's on-page UI space: toasts, a top-right icon, badges pinned to page " +
      'elements. Disclosed, not enforced, for exactly the reason `page.dom` is: a script that shares ' +
      'the page can already append anything it likes to the document, so refusing this protects ' +
      'nobody — what the platform adds is placement, quota and teardown, not permission. It becomes ' +
      'a real gate for scripts hosted in a sandboxed frame (docs/ROADMAP.md §11.8), which have no ' +
      'page DOM to draw on at all.',
    requiresMatch: false,
  },
  'page.fetch': {
    scope: 'page.fetch',
    enforcement: 'disclosed',
    consentLine: 'Make its own network requests from the page',
    description:
      "The script calls `fetch`/`XMLHttpRequest` itself, subject to the page's CORS rules. " +
      'Disclosed for the same reason as `page.dom` — the script already has these globals. It is ' +
      'NOT the same as making requests under the extension\'s identity, which no scope grants yet.',
    requiresMatch: false,
  },
};

export const ALL_SCOPES: SynapseScope[] = Object.keys(SCOPE_CATALOG) as SynapseScope[];

/** One callable method on `synapseApi`, and the scope that gates it. The RPC handler routes by
 * (namespace, method) and refuses anything absent from this list, so an implementation reachable
 * from the transport but missing here is unreachable — deliberately fail-closed. */
export interface ApiMethodDefinition {
  /** Keyed off `SynapseApi` itself, so adding a namespace to the interface without cataloguing
   * its methods here is a type error rather than an undocumented, unreachable API. */
  namespace: keyof SynapseApi;
  method: string;
  scope: SynapseScope;
  signature: string;
  description: string;
  /**
   * How the call reaches its implementation.
   *
   * - `'rpc'` — crosses `chrome.runtime.sendMessage` into the background, where the grant is
   *   re-checked. Subject to all three structured-clone rules in `synapse-api.ts`.
   * - `'in-world'` — implemented inside the caller's own world; no message is ever sent, so there is
   *   no boundary to enforce at and closures are usable. `scopeForApiMethod` deliberately does not
   *   resolve these, which means `rpc-handler.ts` rejects an RPC naming one instead of finding some
   *   background implementation to run: a namespace can be in-world OR privileged, never quietly
   *   both.
   */
  transport: 'rpc' | 'in-world';
}

export const API_METHODS: ApiMethodDefinition[] = [
  {
    namespace: 'storage',
    method: 'get',
    scope: 'storage.rw',
    signature: 'get(key: string): Promise<unknown>',
    description: "Read one of this script's own keys. Resolves to `undefined` when unset.",
    transport: 'rpc',
  },
  {
    namespace: 'storage',
    method: 'set',
    scope: 'storage.rw',
    signature: 'set(key: string, value: unknown): Promise<void>',
    description: 'Write one key. The value must survive structured clone (no functions, no DOM nodes).',
    transport: 'rpc',
  },
  {
    namespace: 'storage',
    method: 'remove',
    scope: 'storage.rw',
    signature: 'remove(key: string): Promise<void>',
    description: 'Delete one key.',
    transport: 'rpc',
  },
  {
    namespace: 'storage',
    method: 'keys',
    scope: 'storage.rw',
    signature: 'keys(): Promise<string[]>',
    description: 'List every key this script has written, without the internal namespace prefix.',
    transport: 'rpc',
  },
  {
    namespace: 'ui',
    method: 'toast',
    scope: 'ui.render',
    signature: 'toast(options: { id, message, actionLabel?, onAction? }): boolean',
    description:
      'Show a card bottom-right; reusing an id updates it in place. Returns false if refused ' +
      '(rate limit, quota, or the user muted this script\'s UI).',
    transport: 'in-world',
  },
  {
    namespace: 'ui',
    method: 'icon',
    scope: 'ui.render',
    signature: 'icon(options: { id, label, title?, onClick }): boolean',
    description: 'Show a persistent round button top-right. Two per script at most.',
    transport: 'in-world',
  },
  {
    namespace: 'ui',
    method: 'badge',
    scope: 'ui.render',
    signature: 'badge(options: { id, target, label, title?, onClick }): boolean',
    description:
      'Pin a small button to a page element, following it as the page scrolls and removing it ' +
      'once the element leaves the document.',
    transport: 'in-world',
  },
  {
    namespace: 'ui',
    method: 'dismiss',
    scope: 'ui.render',
    signature: "dismiss(kind: 'toast' | 'icon' | 'badge', id: string): void",
    description: 'Remove one of your own surfaces. Ids are local to your script.',
    transport: 'in-world',
  },
  {
    namespace: 'ui',
    method: 'clear',
    scope: 'ui.render',
    signature: 'clear(): void',
    description: 'Remove everything this script has drawn.',
    transport: 'in-world',
  },
];

export function isSynapseScope(value: unknown): value is SynapseScope {
  return typeof value === 'string' && value in SCOPE_CATALOG;
}

/**
 * Required scope for an RPC call, or `undefined` if no such *RPC* method exists (⇒ reject).
 *
 * In-world methods resolve to `undefined` on purpose: they have no background implementation, so an
 * inbound RPC naming one is either a stale script or someone probing, and both deserve the same
 * fail-closed answer as a method that does not exist.
 */
export function scopeForApiMethod(namespace: string, method: string): SynapseScope | undefined {
  return API_METHODS.find((m) => m.namespace === namespace && m.method === method && m.transport === 'rpc')?.scope;
}

export type ScopeGrantValidation =
  | { valid: true; grants: SynapseScopeGrant[] }
  | { valid: false; reason: string };

/**
 * Accepts the two authoring shapes (`'storage.rw'` and `{ scope: 'storage.rw', match: [...] }`) and
 * normalizes to the object form that gets persisted. Deliberately strict: an unknown scope name is
 * an error, not a silently-dropped entry — `needs: ['net'|'dom']` being a silent no-op is exactly
 * the failure mode this model replaces (docs/ROADMAP.md §11 Open Points).
 */
export function normalizeScopeGrants(raw: unknown): ScopeGrantValidation {
  if (raw === undefined) return { valid: true, grants: [] };
  if (!Array.isArray(raw)) return { valid: false, reason: 'scopes must be an array' };

  const grants: SynapseScopeGrant[] = [];
  for (const entry of raw) {
    const scope = typeof entry === 'string' ? entry : (entry as { scope?: unknown } | null)?.scope;
    if (!isSynapseScope(scope)) {
      return { valid: false, reason: `unknown scope ${JSON.stringify(scope ?? entry)}` };
    }

    const match = typeof entry === 'string' ? undefined : (entry as { match?: unknown }).match;
    if (match !== undefined && (!Array.isArray(match) || !match.every((m) => typeof m === 'string'))) {
      return { valid: false, reason: `scope "${scope}": match must be an array of match patterns` };
    }
    if (SCOPE_CATALOG[scope].requiresMatch && (!match || match.length === 0)) {
      return { valid: false, reason: `scope "${scope}" requires a non-empty match list` };
    }

    grants.push(match ? { scope, match: match as string[] } : { scope });
  }
  return { valid: true, grants };
}

/**
 * The single funnel for "is this call allowed" — every enforcement point goes through here so the
 * resource dimension (`match`) has exactly one place to be checked once a scope needs it.
 */
export function grantsAllow(grants: SynapseScopeGrant[], scope: SynapseScope): boolean {
  return grants.some((g) => g.scope === scope);
}

/** Consent text for one grant, with `{domains}` filled in from its `match` patterns. */
export function consentLineFor(grant: SynapseScopeGrant): string {
  const line = SCOPE_CATALOG[grant.scope].consentLine;
  const domains = grant.match?.join(', ') ?? 'any site';
  return line.replace('{domains}', domains);
}

/** Grants in `requested` that `granted` does not already cover — what a consent prompt must ask
 * about. Compared by scope name and match list, so a widened `match` re-prompts. */
export function ungrantedScopes(
  requested: SynapseScopeGrant[],
  granted: SynapseScopeGrant[],
): SynapseScopeGrant[] {
  const key = (g: SynapseScopeGrant): string => `${g.scope}|${(g.match ?? []).join(',')}`;
  const have = new Set(granted.map(key));
  return requested.filter((g) => !have.has(key(g)));
}
