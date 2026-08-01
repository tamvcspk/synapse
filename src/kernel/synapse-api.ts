/**
 * `synapseApi` — the one public contract (docs/ROADMAP.md §11.3, `.claude/skills/userscript-api`).
 *
 * This is the ONLY surface with users outside this repo, so it is the only one that gets stability
 * guarantees. Everything else in `src/kernel/` is an internal detail by comparison.
 *
 * THIS FILE MUST STAY IMPORT-FREE AND TYPE-ONLY. `userscript-dts.ts` copies its declarations
 * verbatim into `docs/types/synapse-userscript.d.ts` (asserted by userscript-dts.test.ts), which is
 * how the published types are prevented from drifting away from the implementation. An `import` or
 * a runtime value here would land in that generated file and break it — scope *data* (descriptions,
 * enforcement class) therefore lives in `scopes.ts`, which imports from here, never the reverse.
 *
 * Three hard constraints on every method that CROSSES the transport (`transport: 'rpc'` in
 * `scopes.ts`), all consequences of `chrome.runtime.sendMessage`'s structured-clone boundary —
 * violating them produces silent no-ops, not type errors:
 *   1. Every method is `async`, including ones that feel synchronous.
 *   2. No function-valued parameters, ever (they arrive as `undefined`). Subscriptions must
 *      register their handler locally in the caller's own world.
 *   3. No methods on returned values — return plain data; model a live thing as an id plus
 *      sibling methods that take it.
 *
 * `ui` is the deliberate exception and the only one: it is `transport: 'in-world'`, implemented in
 * the caller's own world with no message ever sent, so it takes closures (`onClick`) and returns
 * synchronously. That exemption is not a shortcut — it is the entire reason docs/ROADMAP.md §11.0
 * placed the UI engine in the script's world rather than in Core. Adding a method here that touches
 * the network, storage, or anything privileged means `rpc`, and the three rules above apply again.
 */

/* @userscript-dts:begin — everything below is copied verbatim into the published .d.ts */

/**
 * A permission a script can be granted. Named after the purpose/resource, never after the
 * transport mechanism — a script declares what it wants to *do*, not which pipe it wants. `bus` is
 * deliberately absent and can never become a scope: `bus.emit(moduleId, …)` reaches every bundled
 * Module's own listener, which is a god-capability no consent prompt can describe honestly.
 */
export type SynapseScope = 'storage.rw' | 'page.dom' | 'page.fetch' | 'ui.render';

/**
 * One entry in a script's `scopes` declaration. `match` is the resource dimension: a grant is
 * (action × origin), the same shape as Tampermonkey's `@connect`. No scope requires it yet — the
 * network-touching scopes that will (docs/ROADMAP.md §11.3 constraint B, §11.6) arrive in Phase 5 —
 * but grants are persisted in this shape from the start so adding one is not a second data
 * migration. A bare string is accepted as shorthand for `{ scope }`.
 */
export interface SynapseScopeGrant {
  scope: SynapseScope;
  /** Match patterns (`*://*.example.com/*`) limiting which origins the scope applies to. */
  match?: string[];
}

/** Per-script key/value storage. Keys are namespaced to the calling script by the platform and
 * there is no way for a key to escape that namespace — see `scopes.ts` for why that is the
 * precondition of the whole permission model rather than a nicety. Scope: `storage.rw`. */
export interface SynapseStorageApi {
  /** Resolves to `undefined` when this script has never written `key`. */
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  /** Every key this script has written, without the internal namespace prefix. */
  keys(): Promise<string[]>;
}

/**
 * In-page UI, allocated and positioned by the platform's compositor. Scope: `ui.render`.
 *
 * **Synchronous, and closures are welcome** — unlike every other namespace here, this one never
 * sends a message. The engine runs in your own world (docs/ROADMAP.md §11.0), so `onClick` is a
 * real function call, not a serialized action id.
 *
 * You never receive a node in shared space, and ids are local to your script: `toast({id:'x'})` from
 * two different scripts creates two different toasts, and there is no way to name — let alone
 * remove — another script's surface. Every method returns `false` when the call was refused (quota
 * exhausted or toast rate limit), never a silent no-op. The user hiding this script's UI is not a
 * refusal: the surface is created and returns `true`, it is simply not displayed until they unhide,
 * at which point everything drawn in the meantime appears at once.
 */
export interface SynapseUiApi {
  /** Card, bottom-right. Reusing an id updates that card in place instead of stacking. */
  toast(options: { id: string; message: string; actionLabel?: string; onAction?: () => void }): boolean;
  /** Persistent round button, top-right. Max 2 per script. */
  icon(options: { id: string; label: string; title?: string; onClick: () => void }): boolean;
  /** Small button pinned to a page element's corner, following it until it leaves the document. */
  badge(options: { id: string; target: Element; label: string; title?: string; onClick: () => void }): boolean;
  dismiss(kind: 'toast' | 'icon' | 'badge', id: string): void;
  /** Removes everything this script has drawn. */
  clear(): void;
}

/** The facade every caller programs against, delivered as `ctx.api`: to bundled Modules from the
 * Kernel, to uploaded user scripts from the shim. One interface, three transports (in-process /
 * content-script RPC / user script shim) — a method reachable from one but not another is a
 * contract break, not a gap. Deliberately never a global: uploaded scripts share one execution
 * world, so a global name has one binding for all of them and could not identify the caller. */
export interface SynapseApi {
  storage: SynapseStorageApi;
  /** Only usable from code that runs on a page. A background Module gets a stub whose every method
   * throws with that explanation — there is no DOM in a service worker to render into. */
  ui: SynapseUiApi;
}

/** What an uploaded user script assigns to `globalThis.__synapseModule` to declare itself. */
export interface SynapseUserScriptManifest {
  /** Display label only. The extension assigns the canonical routing id at upload time, before
   * this script has ever run, so this can never be a routing or storage key. */
  id: string;
  /** Requested scopes. This is a *request*: the grant record the user approved is the authority,
   * and it is re-checked in the background on every single call. */
  scopes?: (SynapseScope | SynapseScopeGrant)[];
  run(input: unknown, ctx: { api: SynapseApi }): Promise<unknown>;
}
