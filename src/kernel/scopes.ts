import { isValidMatchPattern, matchesAnyPattern } from '../shared/match-pattern';
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
      'NOT the same as making requests under the extension\'s identity, which `net.request` grants.',
    requiresMatch: false,
  },
  'net.request': {
    scope: 'net.request',
    enforcement: 'enforced',
    consentLine: 'Make network requests, under this extension\'s identity, to {domains}',
    description:
      "Fetch cross-origin under the extension's own identity rather than the page's — not subject " +
      "to the page's CORS policy, the delta a page script cannot close on its own (docs/api-inventory.md " +
      '§2, "priority #1"). Always carries `match`: a grant is (action × origin), the same shape as ' +
      "Tampermonkey's `@connect`, so a script can only reach the origins it declared.",
    requiresMatch: true,
  },
  'files.save': {
    scope: 'files.save',
    enforcement: 'enforced',
    consentLine: 'Save files to disk',
    description:
      'Write a file into the Downloads folder — the `GM_download` delta a page script has no way to ' +
      'close on its own. No resource dimension: unlike `net.request`, a written file cannot itself ' +
      'exfiltrate anything, so there is no origin to scope it to.',
    requiresMatch: false,
  },
  'net.mock': {
    scope: 'net.mock',
    enforcement: 'enforced',
    consentLine: 'Fake network responses on {domains}',
    description:
      'Answer matching requests to {domains} with a canned response instead of letting them reach ' +
      'the network — for testing error handling or working against an API that is not up yet ' +
      '(docs/api-inventory.md §3.2). v1 only ever fakes a response (no block/rewrite) and always ' +
      'runs under the cheapest mechanism (a MAIN-world fetch/XHR patch, no DevTools "being debugged" ' +
      'banner) — a script cannot request `debugger` or `dnr` directly.',
    requiresMatch: true,
  },
  media: {
    scope: 'media',
    enforcement: 'enforced',
    consentLine: 'Detect, inspect and download media (video/audio/HLS) found on any page',
    description:
      'List media the network sniffer has detected, inspect an HLS manifest, and start/poll/control ' +
      'a download - the GM_video-shaped hole Tampermonkey has no equivalent for at all ' +
      '(docs/api-inventory.md section 3.1). One scope for list/inspect/download/job/control: splitting ' +
      'detection from download would be an empty two-prompt ritual (anyone who allows detection also ' +
      'wants to download). No `match` dimension - unlike `net.request`/`net.mock`, this is ' +
      'all-or-nothing, the same posture the Side Panel already takes toward everything it detects.',
    requiresMatch: false,
  },
  'page.eval': {
    scope: 'page.eval',
    enforcement: 'enforced',
    consentLine: "Run arbitrary code in the page's own JavaScript context on {domains}",
    description:
      "Execute code directly in the page's MAIN-world JS context — the `unsafeWindow` delta a " +
      'USER_SCRIPT-world script has no way to close on its own (docs/api-inventory.md §2). The ' +
      'highest-privilege scope in the catalog: granted code runs with the full authority of the ' +
      "page's own JS context, not a sandboxed subset. Requires `match`, but the resource checked " +
      "is not an argument the script provides — it is the calling tab's REAL url, read from the " +
      'platform\'s own record of the call, so a script cannot widen its own reach by lying about ' +
      'which page it is calling from.',
    requiresMatch: true,
  },
  'secrets.use': {
    scope: 'secrets.use',
    enforcement: 'enforced',
    consentLine: 'Use named secrets it declares, inside network requests it makes',
    description:
      'Lets `net.request` substitute a header value from a secret this script references by name ' +
      '(`secretRef`) — the script never receives the secret itself, only the ability to have the ' +
      'platform inject it at the network boundary (docs/ROADMAP.md §11.6). No scope named ' +
      '`secrets.read` exists, and none ever will: reading a secret back out is not a capability any ' +
      'script can be granted, and there is no way to list secrets either — a script must already ' +
      'know the exact name it wants. Each secret is independently bound to one host at creation ' +
      'time (Dashboard-only, never scriptable) — this scope only gates whether the script may ' +
      'reference a secret AT ALL; which host it may reach with it is that secret\'s own binding, ' +
      'checked regardless of this grant. No `match` here: the resource dimension already belongs ' +
      "to `net.request`'s own grant and to the secret's binding — a third, independent match list " +
      'on this scope would just be a second place for the same fact to drift out of sync.',
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
  /** Absent ONLY for `lib.*` (docs/api-inventory.md §3.0): pure computation on data the caller
   * already holds, granted no privilege, so there is nothing for a scope to gate. Every other
   * namespace must carry one — `isSynapseScope` failing on a real scope name is a bug, not a
   * legitimate absence. */
  scope?: SynapseScope;
  signature: string;
  description: string;
  /** For a method whose scope `requiresMatch` (§11.3 constraint B): pulls the resource URL out of
   * the call's own arguments (or, for `page.eval`, out of `context` — see `ResourceUrlContext`),
   * so the boundary can check it against the grant's `match` patterns without knowing each
   * namespace's argument shape. Absent for every method whose scope doesn't require one —
   * `grantsAllow` only consults it when `SCOPE_CATALOG[scope].requiresMatch`. */
  resourceUrl?: (args: unknown[], context: ResourceUrlContext) => string | undefined;
  /** True for a method gated by a `requiresMatch` scope that does NOT itself introduce a new
   * resource — it only reads or removes something the caller already owns, whose origin was
   * already checked against `match` at the moment it was *created* (e.g. `mock.remove`/`mock.list`
   * next to `mock.add`, which does carry a `resourceUrl`). Without this, `grantsAllow`'s fail-closed
   * "no resourceUrl ⇒ deny" rule (correct for a call that DOES touch a new resource but couldn't
   * say which) would make these methods permanently unusable — there is no per-call URL to extract
   * for "list everything I already made". `resolveScopeCheck` below is the one place this is read;
   * ownership (moduleId) is still what actually isolates one caller's resources from another's, this
   * flag only says the match dimension isn't the right check for THIS method. Absent (false) for
   * everything else, including every method on a scope that isn't `requiresMatch` at all. */
  matchExempt?: boolean;
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

/** What a `resourceUrl` extractor gets besides the call's own `args` — populated by
 * `rpc-handler.ts` from `chrome.runtime.MessageSender`, never from anything the caller sent. Exists
 * for `page.eval`: unlike `net.request`'s `options.url` or `net.mock`'s `endpointPattern`, there is
 * no argument naming which page a call is about — the resource IS the tab the call came from, and
 * trusting a caller-supplied URL for that would let a script claim a different origin than the one
 * it is actually running on. */
export interface ResourceUrlContext {
  /** The real URL of the tab the call originated from, when the transport could determine one
   * (always true for a content-script or uploaded-script caller; absent for an in-process bundled
   * Module, which has no tab of its own). */
  tabUrl?: string;
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
  {
    namespace: 'net',
    method: 'request',
    scope: 'net.request',
    signature: 'request(options: SynapseNetRequestOptions): Promise<SynapseNetResponse>',
    description:
      "Fetch a URL under the extension's identity, not the page's — bypasses the page's CORS " +
      'policy. `options.url` must fall under one of this call\'s granted `match` patterns. A ' +
      'header value may reference a named secret instead of a plain string — see `secrets.use`.',
    resourceUrl: (args) => {
      const options = args[0] as { url?: unknown } | undefined;
      return typeof options?.url === 'string' ? options.url : undefined;
    },
    transport: 'rpc',
  },
  {
    namespace: 'files',
    method: 'save',
    scope: 'files.save',
    signature: 'save(options: SynapseFilesSaveOptions): Promise<SynapseFilesSaveResult>',
    description: 'Write `options.content` to `options.filename` inside the Downloads folder.',
    transport: 'rpc',
  },
  {
    namespace: 'net',
    method: 'mock.add',
    scope: 'net.mock',
    signature: 'mock.add(options: SynapseMockRuleOptions): Promise<{ id: string }>',
    description:
      'Fake matching requests with a canned response. `options.endpointPattern` must have a ' +
      'literal (non-wildcard) scheme and host falling under one of this call\'s granted `match` ' +
      'patterns — only the path may use `*`; the mechanism (always the cheapest one) is chosen by ' +
      'the platform, not requested.',
    resourceUrl: (args) => {
      const options = args[0] as { endpointPattern?: unknown } | undefined;
      return typeof options?.endpointPattern === 'string' ? options.endpointPattern : undefined;
    },
    transport: 'rpc',
  },
  {
    namespace: 'net',
    method: 'mock.remove',
    scope: 'net.mock',
    signature: 'mock.remove(id: string): Promise<void>',
    description: 'Remove one of this script\'s own rules. Ids from another script or from the Management View are refused.',
    matchExempt: true,
    transport: 'rpc',
  },
  {
    namespace: 'net',
    method: 'mock.list',
    scope: 'net.mock',
    signature: 'mock.list(): Promise<SynapseMockRule[]>',
    description: 'List this script\'s own rules — never another script\'s or the user\'s manually-created ones.',
    matchExempt: true,
    transport: 'rpc',
  },
  {
    namespace: 'media',
    method: 'list',
    scope: 'media',
    signature: 'list(): Promise<SynapseMediaEntry[]>',
    description: 'Every media file the network sniffer has detected so far — the same list the Side Panel shows.',
    transport: 'rpc',
  },
  {
    namespace: 'media',
    method: 'inspect',
    scope: 'media',
    signature: 'inspect(url: string): Promise<SynapseMediaInspectResult>',
    description: 'Fetch and parse an HLS manifest URL fresh (not a cached read).',
    transport: 'rpc',
  },
  {
    namespace: 'media',
    method: 'download',
    scope: 'media',
    signature: 'download(options: SynapseMediaDownloadOptions): Promise<string>',
    description: 'Start a download; returns the jobId immediately without waiting for completion.',
    transport: 'rpc',
  },
  {
    namespace: 'media',
    method: 'job',
    scope: 'media',
    signature: 'job(jobId: string): Promise<SynapseMediaJobStatus | undefined>',
    description: 'Poll a snapshot of a download started by media.download — no subscription exists (docs/api-inventory.md §4).',
    transport: 'rpc',
  },
  {
    namespace: 'media',
    method: 'control',
    scope: 'media',
    signature: "control(jobId: string, action: 'pause' | 'resume' | 'cancel' | 'stop-live'): Promise<void>",
    description: 'Act on a job started by media.download.',
    transport: 'rpc',
  },
  {
    namespace: 'media',
    method: 'onProgress',
    scope: 'media',
    signature: 'onProgress(jobId: string, handler: (status: SynapseMediaJobStatus) => void): () => void',
    description:
      'Push updates for a job started by media.download, instead of polling job() — the first real ' +
      'use of the subscription mechanism docs/api-inventory.md §4 spiked (§6 item 8), confirmed on ' +
      'real Chrome. Runs in your own world, like ui.*, and never reaches this scope check the way ' +
      'job()/download() do (a function-valued handler cannot cross the RPC boundary at all).',
    transport: 'in-world',
  },
  {
    namespace: 'page',
    method: 'eval',
    scope: 'page.eval',
    signature: 'eval(code: string, args?: unknown[]): Promise<unknown>',
    description:
      "Run code in the page's own MAIN-world JS context (Tampermonkey's `unsafeWindow`, made an " +
      'explicit call) — breaks the isolation the USER_SCRIPT world otherwise guarantees. `code` runs ' +
      "as an async function body; `args` become its own `args` parameter. Gated on the calling tab's " +
      'REAL url falling under this call\'s granted `match` patterns — not a url the script provides.',
    resourceUrl: (_args, context) => context.tabUrl,
    transport: 'rpc',
  },
  {
    namespace: 'ai',
    method: 'ask',
    // Reuses net.request's own scope rather than adding an 11th (the catalog is already at its
    // self-imposed ~10 ceiling, docs/ROADMAP.md §11.6) — ai.ask does not open any door net.request +
    // secretRef didn't already open, it only shapes the request and extracts the reply text, so it
    // does not warrant a second gate. A script granting net.request match for a provider's host can
    // call ai.ask against it; one that hasn't gets the same denial calling net.request there would.
    scope: 'net.request',
    signature: 'ask(options: SynapseAiAskOptions): Promise<SynapseAiAskResult>',
    description:
      "Thin {provider,model,messages} → text helper for OpenAI/Ollama chat completions — not a " +
      'unified LLM abstraction, see the type doc comment. `options.baseUrl` (or the provider\'s ' +
      "default endpoint) must fall under one of this call's granted `net.request` `match` patterns, " +
      'the same requirement calling that endpoint via `net.request` directly would carry. A ' +
      '`secretRef` additionally requires `secrets.use`, injected as `Authorization: Bearer <value>`.',
    resourceUrl: (args) => {
      const options = args[0] as { provider?: unknown; baseUrl?: unknown } | undefined;
      if (typeof options?.baseUrl === 'string') return options.baseUrl;
      if (options?.provider === 'openai') return 'https://api.openai.com/v1/chat/completions';
      if (options?.provider === 'ollama') return 'http://localhost:11434/api/chat';
      return undefined;
    },
    transport: 'rpc',
  },
  {
    namespace: 'lib',
    method: 'hls.parse',
    signature: 'hls.parse(text: string, baseUrl: string): SynapseHlsManifest',
    description:
      'Parse an HLS (.m3u8) manifest already fetched by the script. No scope: pure computation ' +
      'on data the caller already has, granted no privilege (docs/api-inventory.md §3.0).',
    transport: 'in-world',
  },
  {
    namespace: 'lib',
    method: 'readable',
    signature: 'readable(doc?: Document): { title, root, text } | undefined',
    description:
      'Extract the readable article from a Document via Mozilla Readability. Mutates `doc`; ' +
      'clones the page\'s own document when omitted. No scope — only meaningful where a page DOM ' +
      'exists, same as `ui`, but fails with a plain error rather than a crafted stub elsewhere.',
    transport: 'in-world',
  },
  {
    namespace: 'lib',
    method: 'toMarkdown',
    signature: 'toMarkdown(root: Node, options: { baseUrl, resolveImageUrl? }): string',
    description: 'Convert a DOM subtree to Markdown. No scope: pure computation on a Node the caller already has.',
    transport: 'in-world',
  },
  {
    namespace: 'lib',
    method: 'zip',
    signature: 'zip(entries: { name, data }[]): Uint8Array',
    description: 'Build an uncompressed .zip archive from named byte buffers. No scope: pure computation.',
    transport: 'in-world',
  },
  {
    namespace: 'lib',
    method: 'matchPattern.isValid',
    signature: 'matchPattern.isValid(pattern: string): boolean',
    description: 'Whether pattern is well-formed Chrome match-pattern syntax. No scope: pure computation.',
    transport: 'in-world',
  },
  {
    namespace: 'lib',
    method: 'matchPattern.test',
    signature: 'matchPattern.test(url: string, pattern: string): boolean',
    description: 'Whether url falls under pattern - the exact matcher net.request/net.mock enforce against. No scope: pure computation.',
    transport: 'in-world',
  },
  {
    namespace: 'lib',
    method: 'matchPattern.testAny',
    signature: 'matchPattern.testAny(url: string, patterns: string[]): boolean',
    description: 'Whether url falls under any of patterns. No scope: pure computation.',
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

/** The resource URL (if any) a call is about, per that method's own `resourceUrl` extractor — the
 * boundary needs this to check a `requiresMatch` scope's `match` patterns without special-casing
 * each namespace. Returns `undefined` for a method with no extractor, same as one with none named. */
export function resourceUrlForCall(
  namespace: string,
  method: string,
  args: unknown[],
  context: ResourceUrlContext = {},
): string | undefined {
  const def = API_METHODS.find((m) => m.namespace === namespace && m.method === method && m.transport === 'rpc');
  return def?.resourceUrl?.(args, context);
}

/** Whether this call should skip the `requiresMatch` resource check even though its scope carries
 * one — see `ApiMethodDefinition.matchExempt`'s doc comment for why that's a legitimate answer and
 * not a hole: it only ever applies to a method that reads/removes something already scoped at
 * creation, never one that reaches a new resource. */
export function isMatchExemptMethod(namespace: string, method: string): boolean {
  return API_METHODS.find((m) => m.namespace === namespace && m.method === method && m.transport === 'rpc')?.matchExempt ?? false;
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
    if (match) {
      const invalid = (match as string[]).find((m) => !isValidMatchPattern(m));
      if (invalid !== undefined) {
        return { valid: false, reason: `scope "${scope}": "${invalid}" is not a valid match pattern` };
      }
    }

    grants.push(match ? { scope, match: match as string[] } : { scope });
  }
  return { valid: true, grants };
}

/**
 * The single funnel for "is this call allowed" — every enforcement point goes through here so the
 * resource dimension (`match`) has exactly one place to be checked once a scope needs it.
 *
 * `resourceUrl` is what the call is actually about (`resourceUrlForCall`'s result) — required only
 * for a `requiresMatch` scope, and its absence there is a deny, not a pass: a scope that carries a
 * resource dimension is meaningless without one to check, and failing open on a missing URL would
 * turn "I couldn't tell what this call touches" into "allow it anyway".
 */
export function grantsAllow(grants: SynapseScopeGrant[], scope: SynapseScope, resourceUrl?: string): boolean {
  const matching = grants.filter((g) => g.scope === scope);
  if (matching.length === 0) return false;
  if (!SCOPE_CATALOG[scope].requiresMatch) return true;
  if (!resourceUrl) return false;
  return matching.some((g) => matchesAnyPattern(resourceUrl, g.match ?? []));
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
