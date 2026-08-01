/**
 * Types for writing a Synapse user script — GENERATED from src/kernel/synapse-api.ts and
 * src/kernel/scopes.ts. Do not edit by hand: regenerate with `npm test -- -u`.
 *
 * Reference this file in your own editor for autocomplete. It has no effect on the extension build
 * (it lives outside src/, which is all tsconfig.json includes) and is never imported at runtime:
 * `synapseApi` and `__synapseModule` are plain globals the extension injects around your code.
 * See docs/user-scripts.md for the authoring convention.
 */

/**
 * ## Scopes
 *
 * ### Enforced — the call fails if the user denies it
 *
 * - `storage.rw` — Store this script's own data.
 *   Read and write a key/value store private to this script. Keys are namespaced by the
 *   platform: this script cannot see another script's data, nor the extension's own settings.
 *
 * ### Disclosed — the script can do this anyway; declaring it is transparency, not a gate
 *
 * - `page.dom` — Read and modify the content of pages it runs on.
 *   The script reads or changes the page it is injected into. Disclosed, not enforced: a script
 *   running on the page already shares its DOM, so `document.querySelector` works whether or not
 *   this is granted. It becomes genuinely enforced only for scripts hosted in a sandboxed frame
 *   (docs/ROADMAP.md §11.8), which have no page DOM at all.
 * - `page.fetch` — Make its own network requests from the page.
 *   The script calls `fetch`/`XMLHttpRequest` itself, subject to the page's CORS rules.
 *   Disclosed for the same reason as `page.dom` — the script already has these globals. It is
 *   NOT the same as making requests under the extension's identity, which no scope grants yet.
 *
 * ## Methods
 *
 * - `synapseApi.storage.get(key: string): Promise<unknown>` — requires `storage.rw`.
 *   Read one of this script's own keys. Resolves to `undefined` when unset.
 * - `synapseApi.storage.set(key: string, value: unknown): Promise<void>` — requires `storage.rw`.
 *   Write one key. The value must survive structured clone (no functions, no DOM nodes).
 * - `synapseApi.storage.remove(key: string): Promise<void>` — requires `storage.rw`.
 *   Delete one key.
 * - `synapseApi.storage.keys(): Promise<string[]>` — requires `storage.rw`.
 *   List every key this script has written, without the internal namespace prefix.
 */

/**
 * A permission a script can be granted. Named after the purpose/resource, never after the
 * transport mechanism — a script declares what it wants to *do*, not which pipe it wants. `bus` is
 * deliberately absent and can never become a scope: `bus.emit(moduleId, …)` reaches every bundled
 * Module's own listener, which is a god-capability no consent prompt can describe honestly.
 */
type SynapseScope = 'storage.rw' | 'page.dom' | 'page.fetch';

/**
 * One entry in a script's `scopes` declaration. `match` is the resource dimension: a grant is
 * (action × origin), the same shape as Tampermonkey's `@connect`. No scope requires it yet — the
 * network-touching scopes that will (docs/ROADMAP.md §11.3 constraint B, §11.6) arrive in Phase 5 —
 * but grants are persisted in this shape from the start so adding one is not a second data
 * migration. A bare string is accepted as shorthand for `{ scope }`.
 */
interface SynapseScopeGrant {
  scope: SynapseScope;
  /** Match patterns (`*://*.example.com/*`) limiting which origins the scope applies to. */
  match?: string[];
}

/** Per-script key/value storage. Keys are namespaced to the calling script by the platform and
 * there is no way for a key to escape that namespace — see `scopes.ts` for why that is the
 * precondition of the whole permission model rather than a nicety. Scope: `storage.rw`. */
interface SynapseStorageApi {
  /** Resolves to `undefined` when this script has never written `key`. */
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  /** Every key this script has written, without the internal namespace prefix. */
  keys(): Promise<string[]>;
}

/** The facade every caller programs against, delivered as `ctx.api`: to bundled Modules from the
 * Kernel, to uploaded user scripts from the shim. One interface, three transports (in-process /
 * content-script RPC / user script shim) — a method reachable from one but not another is a
 * contract break, not a gap. Deliberately never a global: uploaded scripts share one execution
 * world, so a global name has one binding for all of them and could not identify the caller. */
interface SynapseApi {
  storage: SynapseStorageApi;
}

/** What an uploaded user script assigns to `globalThis.__synapseModule` to declare itself. */
interface SynapseUserScriptManifest {
  /** Display label only. The extension assigns the canonical routing id at upload time, before
   * this script has ever run, so this can never be a routing or storage key. */
  id: string;
  /** Requested scopes. This is a *request*: the grant record the user approved is the authority,
   * and it is re-checked in the background on every single call. */
  scopes?: (SynapseScope | SynapseScopeGrant)[];
  run(input: unknown, ctx: { api: SynapseApi }): Promise<unknown>;
}

/**
 * Assign this to declare your script. `scopes` is a *request*: the extension re-checks the grant
 * the user approved on every call, so a scope you declared but the user denied fails at the call,
 * not at load.
 *
 * The API arrives as `run()`'s `ctx.api` — there is deliberately **no** `synapseApi` global.
 * Every uploaded script shares one execution world, so a global has a single binding for all of
 * them and cannot tell the platform which script is calling; the last script loaded would own the
 * name and everyone else's calls would run under its identity and its permissions. To use the API
 * outside `run()`, capture it: `let api; …async run(input, ctx) { api = ctx.api; }`.
 * (The name `synapseApi` does exist in that world, but every method on it rejects with this
 * explanation — a loud failure instead of a silent impersonation.)
 */
declare let __synapseModule: SynapseUserScriptManifest;
