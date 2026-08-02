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
export type SynapseScope = 'storage.rw' | 'page.dom' | 'page.fetch' | 'ui.render' | 'net.request' | 'files.save' | 'net.mock';

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

/** One outbound request for `net.request`. `match` in the granted scope is checked against `url`
 * before this ever reaches the network — a URL that doesn't fall under one of the script's granted
 * patterns fails at the call site, same as any other denied scope. */
export interface SynapseNetRequestOptions {
  url: string;
  /** Defaults to `'GET'`. */
  method?: string;
  headers?: Record<string, string>;
  /** Must survive structured clone: a string, never a live body stream. Binary payloads go through
   * `bodyEncoding: 'base64'`, the same convention `shared/http-mock.ts`'s `bodyEncoding` uses. */
  body?: string;
  /** How `body` is encoded. Defaults to `'utf8'`. */
  bodyEncoding?: 'utf8' | 'base64';
  /** `'text'` (default) decodes the response as UTF-8 text; `'arraybuffer'` returns it
   * base64-encoded in the response's `body`, for binary responses (images, zips). */
  responseType?: 'text' | 'arraybuffer';
  /** Defaults to 30s, capped at 120s. */
  timeoutMs?: number;
}

/** What `net.request` resolves to on any HTTP response, including 4xx/5xx — those are not thrown,
 * the same way `fetch()` itself only rejects on a network failure, never a non-2xx status. */
export interface SynapseNetResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Encoded per `responseType`: UTF-8 text when `'text'`, base64 when `'arraybuffer'` — check
   * `bodyEncoding` rather than assuming, since it reflects what was actually requested. */
  body: string;
  bodyEncoding: 'utf8' | 'base64';
  /** The final URL after any redirects. */
  url: string;
}

/** One rule for `synapseApi.mock.add` (docs/api-inventory.md §3.2). `endpointPattern` must have a
 * literal (non-wildcard) scheme and host under one of this call's granted `net.mock` `match`
 * patterns — only the path may use `*` (`https://api.example.com/*`, never `*://*.example.com/*`);
 * a wildcarded scheme/host is rejected at the grant check, the same fail-closed answer a mismatched
 * origin gets. `method` mirrors `shared/http-mock.ts`'s `HttpMethod`, duplicated (not imported) per
 * this file's own import-free constraint — `'ALL'` (the default) matches every method. */
export interface SynapseMockRuleOptions {
  endpointPattern: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ALL';
  /** HTTP status to answer with. Defaults to 200. */
  fakeStatus?: number;
  /** The response body. A string is sent as-is; anything else is JSON-serialized. */
  fakeResponse?: unknown;
  /** Answers this many milliseconds late, to test loading states. */
  delayMs?: number;
}

/** What `mock.list()` returns for one of this script's own rules — the same fields `add` accepted,
 * echoed back with the id it was assigned and its mechanism/action fixed for v1 (always a
 * MAIN-world fake-response, docs/api-inventory.md §3.2 — see `SynapseNetMockApi`'s doc comment). */
export interface SynapseMockRule {
  id: string;
  endpointPattern: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ALL';
  fakeStatus: number;
  fakeResponse?: unknown;
  delayMs?: number;
}

/**
 * Fakes matching requests instead of letting them reach the network — for testing error handling
 * or working against an API that doesn't exist yet. Scope: `net.mock`, always carries `match`.
 *
 * **v1 is deliberately narrow**: only `action: 'fake-response'`, and the interception mechanism is
 * always the platform's cheapest choice (a MAIN-world `fetch`/`XMLHttpRequest` patch — no DevTools
 * "being debugged" banner, no `chrome.declarativeNetRequest` rule budget spent). A script declares
 * *what* it wants (the endpoint, the fake response); it never picks *how* that's intercepted — see
 * docs/api-inventory.md §3.2 for why. Blocking/rewriting a real request, or a rule visible in the
 * Network tab, is only available today through the Management View's own "HTTP Mock & Rewrite"
 * panel, by hand.
 */
export interface SynapseNetMockApi {
  add(options: SynapseMockRuleOptions): Promise<{ id: string }>;
  /** Removes one of your own rules. An id belonging to another script, or to a rule created by hand
   * in the Management View, is refused — ids are not a capability, ownership is checked server-side. */
  remove(id: string): Promise<void>;
  /** Every rule this script has added, never another script's or the user's own. */
  list(): Promise<SynapseMockRule[]>;
}

/** Fetches under the extension's own identity — not the page's — so it is not subject to the
 * page's CORS policy (that's `page.fetch`, disclosed, unchanged). Scope: `net.request`, and every
 * grant carries `match`: a script can only reach the origins it declared, the same (action × origin)
 * shape as Tampermonkey's `@connect`. */
export interface SynapseNetApi {
  request(options: SynapseNetRequestOptions): Promise<SynapseNetResponse>;
  mock: SynapseNetMockApi;
}

/** One file to write to disk. Scope: `files.save` — the delta a script cannot close on its own
 * (`GM_download` in the Tampermonkey world; there is no page API that writes to the filesystem). */
export interface SynapseFilesSaveOptions {
  /** Relative to the browser's Downloads folder; may include subfolders (`'exports/x.json'`).
   * Never an absolute path or a `..` segment — rejected before this reaches `chrome.downloads`. */
  filename: string;
  /** Must survive structured clone: a string, never a live Blob/stream. Binary content goes through
   * `contentEncoding: 'base64'`, the same convention `net.request`'s body/response use. */
  content: string;
  /** Defaults to `'utf8'`. */
  contentEncoding?: 'utf8' | 'base64';
  /** Defaults to `'text/plain;charset=utf-8'` for utf8 content, `'application/octet-stream'` for
   * base64 content. */
  mimeType?: string;
  /** Prompts the user for a save location instead of writing straight to `filename`. Defaults to
   * `false`. */
  saveAs?: boolean;
}

export interface SynapseFilesSaveResult {
  /** Chrome's own download id — usable with `chrome://downloads` but not with any `synapseApi`
   * method today; there is no `files.*` follow-up call yet (no progress/cancel). */
  downloadId: number;
}

export interface SynapseFilesApi {
  save(options: SynapseFilesSaveOptions): Promise<SynapseFilesSaveResult>;
}

/** One variant listed by an HLS master playlist — itself another manifest URL, not a video. */
export interface SynapseHlsManifestVariant {
  url: string;
  /** From `RESOLUTION=WxH`. Absent when the playlist doesn't advertise one (e.g. audio-only). */
  resolution?: string;
}

/** One `#EXT-X-KEY` tag's worth of info. `method !== 'AES-128'`, or any `keyFormat` other than
 * absent/`'identity'`, means real DRM (Widevine/PlayReady/FairPlay) — not something to decrypt. */
export interface SynapseHlsSegmentKey {
  method: string;
  uri: string;
  iv?: string;
  keyFormat?: string;
}

export interface SynapseHlsManifestSegment {
  url: string;
  key?: SynapseHlsSegmentKey;
  byteRange?: string;
}

/** What `lib.hls.parse` returns — mirrors `shared/media-manifest-parser.ts`'s `ParsedManifest`
 * exactly (duplicated here, not imported: this file must stay import-free, see the file banner). */
export type SynapseHlsManifest =
  | { kind: 'master'; variants: SynapseHlsManifestVariant[] }
  | {
      kind: 'media';
      segments: SynapseHlsManifestSegment[];
      /** The init segment of a fragmented-MP4 (CMAF) stream — `undefined` for MPEG-TS. */
      initSegment?: SynapseHlsManifestSegment;
      encrypted: boolean;
      isLive: boolean;
      mediaSequence: number;
      targetDurationSec?: number;
    }
  | { kind: 'unknown' };

/**
 * Pure computation on data the caller already has in hand — no privilege granted, no scope, no
 * message ever sent (docs/api-inventory.md §3.0). `lib.*` exists purely to save a script from
 * re-implementing something Synapse's own builtins already had to get right (here: the HLS
 * media-playlist parser `download`'s decrypt/remux engine relies on, docs/ROADMAP.md §8.4).
 *
 * Reachable from every context — unlike `ui`, which needs a page. Synchronous, like `ui`, for the
 * same reason: there is no transport boundary to cross, so there is nothing to `await`.
 */
export interface SynapseLibApi {
  hls: {
    /** `baseUrl` resolves the manifest's relative URIs (segments, variants, keys) to absolute
     * ones — pass the URL the manifest text was fetched from. */
    parse(text: string, baseUrl: string): SynapseHlsManifest;
  };
  /** Extracts the readable article from a page-like `Document`, via Mozilla's Readability — the
   * same engine behind Firefox's Reader View, and the same one `reader-mode-converter`'s builtin
   * uses. **Mutates `doc`**; pass a clone if the original must stay untouched. Omit `doc` to have
   * Synapse operate on a clone of the current page's own `document` for you. Returns `undefined`
   * when Readability decides the page isn't an article — same "no privilege, honest primitive"
   * posture as the rest of `lib.*`: this never guesses a fallback for you. Only meaningful where a
   * `Document` exists; calling with no `doc` from a context with no page (a background Module)
   * fails with a plain `ReferenceError`, not a crafted message — there is nothing privileged being
   * denied, just a missing input. */
  readable(doc?: Document): { title: string; root: Element; text: string } | undefined;
  /** Converts a DOM subtree to Markdown (mixmark-io/turndown under the hood) — the same converter
   * `reader-mode-converter` uses. `root` is typically `lib.readable(...)`'s `root`, but any Node
   * works; `options.resolveImageUrl` lets you point image links at local copies you've already
   * `net.request`-ed instead of the original remote URL. */
  toMarkdown(root: Node, options: { baseUrl: string; resolveImageUrl?: (absoluteUrl: string) => string }): string;
  /** Builds an uncompressed (STORE method) `.zip` archive from named byte buffers — hand-rolled,
   * no dependency (docs/ROADMAP.md §1). Pass the result to `files.save` with
   * `contentEncoding: 'base64'` to write it to disk. */
  zip(entries: { name: string; data: Uint8Array }[]): Uint8Array;
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
  net: SynapseNetApi;
  files: SynapseFilesApi;
  lib: SynapseLibApi;
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
