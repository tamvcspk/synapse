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
 * - `net.request` — Make network requests, under this extension's identity, to {domains}.
 *   Fetch cross-origin under the extension's own identity rather than the page's — not subject
 *   to the page's CORS policy, the delta a page script cannot close on its own
 *   (docs/api-inventory.md §2, "priority #1"). Always carries `match`: a grant is (action ×
 *   origin), the same shape as Tampermonkey's `@connect`, so a script can only reach the origins
 *   it declared.
 *   Requires a `match` list: `{ scope, match: [...] }`.
 * - `files.save` — Save files to disk.
 *   Write a file into the Downloads folder — the `GM_download` delta a page script has no way to
 *   close on its own. No resource dimension: unlike `net.request`, a written file cannot itself
 *   exfiltrate anything, so there is no origin to scope it to.
 * - `net.mock` — Fake network responses on {domains}.
 *   Answer matching requests to {domains} with a canned response instead of letting them reach
 *   the network — for testing error handling or working against an API that is not up yet
 *   (docs/api-inventory.md §3.2). v1 only ever fakes a response (no block/rewrite) and always
 *   runs under the cheapest mechanism (a MAIN-world fetch/XHR patch, no DevTools "being
 *   debugged" banner) — a script cannot request `debugger` or `dnr` directly.
 *   Requires a `match` list: `{ scope, match: [...] }`.
 * - `media` — Detect, inspect and download media (video/audio/HLS) found on any page.
 *   List media the network sniffer has detected, inspect an HLS manifest, and start/poll/control
 *   a download - the GM_video-shaped hole Tampermonkey has no equivalent for at all
 *   (docs/api-inventory.md section 3.1). One scope for list/inspect/download/job/control:
 *   splitting detection from download would be an empty two-prompt ritual (anyone who allows
 *   detection also wants to download). No `match` dimension - unlike `net.request`/`net.mock`,
 *   this is all-or-nothing, the same posture the Side Panel already takes toward everything it
 *   detects.
 * - `page.eval` — Run arbitrary code in the page's own JavaScript context on {domains}.
 *   Execute code directly in the page's MAIN-world JS context — the `unsafeWindow` delta a
 *   USER_SCRIPT-world script has no way to close on its own (docs/api-inventory.md §2). The
 *   highest-privilege scope in the catalog: granted code runs with the full authority of the
 *   page's own JS context, not a sandboxed subset. Requires `match`, but the resource checked is
 *   not an argument the script provides — it is the calling tab's REAL url, read from the
 *   platform's own record of the call, so a script cannot widen its own reach by lying about
 *   which page it is calling from.
 *   Requires a `match` list: `{ scope, match: [...] }`.
 * - `secrets.use` — Use named secrets it declares, inside network requests it makes.
 *   Lets `net.request` substitute a header value from a secret this script references by name
 *   (`secretRef`) — the script never receives the secret itself, only the ability to have the
 *   platform inject it at the network boundary (docs/ROADMAP.md §11.6). No scope named
 *   `secrets.read` exists, and none ever will: reading a secret back out is not a capability any
 *   script can be granted, and there is no way to list secrets either — a script must already
 *   know the exact name it wants. Each secret is independently bound to one host at creation
 *   time (Dashboard-only, never scriptable) — this scope only gates whether the script may
 *   reference a secret AT ALL; which host it may reach with it is that secret's own binding,
 *   checked regardless of this grant. No `match` here: the resource dimension already belongs to
 *   `net.request`'s own grant and to the secret's binding — a third, independent match list on
 *   this scope would just be a second place for the same fact to drift out of sync.
 *
 * ### Disclosed — the script can do this anyway; declaring it is transparency, not a gate
 *
 * - `page.dom` — Read and modify the content of pages it runs on.
 *   The script reads or changes the page it is injected into. Disclosed, not enforced: a script
 *   running on the page already shares its DOM, so `document.querySelector` works whether or not
 *   this is granted. It becomes genuinely enforced only for scripts hosted in a sandboxed frame
 *   (docs/ROADMAP.md §11.8), which have no page DOM at all.
 * - `ui.render` — Show toasts, icons and badges on pages it runs on.
 *   Draw into Synapse's on-page UI space: toasts, a top-right icon, badges pinned to page
 *   elements. Disclosed, not enforced, for exactly the reason `page.dom` is: a script that
 *   shares the page can already append anything it likes to the document, so refusing this
 *   protects nobody — what the platform adds is placement, quota and teardown, not permission.
 *   It becomes a real gate for scripts hosted in a sandboxed frame (docs/ROADMAP.md §11.8),
 *   which have no page DOM to draw on at all.
 * - `page.fetch` — Make its own network requests from the page.
 *   The script calls `fetch`/`XMLHttpRequest` itself, subject to the page's CORS rules.
 *   Disclosed for the same reason as `page.dom` — the script already has these globals. It is
 *   NOT the same as making requests under the extension's identity, which `net.request` grants.
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
 * - `synapseApi.ui.toast(options: { id, message, actionLabel?, onAction? }): boolean` — requires `ui.render` (runs in your own world — synchronous).
 *   Show a card bottom-right; reusing an id updates it in place. Returns false if refused (rate
 *   limit, quota, or the user muted this script's UI).
 * - `synapseApi.ui.icon(options: { id, label, title?, onClick }): boolean` — requires `ui.render` (runs in your own world — synchronous).
 *   Show a persistent round button top-right. Two per script at most.
 * - `synapseApi.ui.badge(options: { id, target, label, title?, onClick }): boolean` — requires `ui.render` (runs in your own world — synchronous).
 *   Pin a small button to a page element, following it as the page scrolls and removing it once
 *   the element leaves the document.
 * - `synapseApi.ui.dismiss(kind: 'toast' | 'icon' | 'badge', id: string): void` — requires `ui.render` (runs in your own world — synchronous).
 *   Remove one of your own surfaces. Ids are local to your script.
 * - `synapseApi.ui.clear(): void` — requires `ui.render` (runs in your own world — synchronous).
 *   Remove everything this script has drawn.
 * - `synapseApi.net.request(options: SynapseNetRequestOptions): Promise<SynapseNetResponse>` — requires `net.request`.
 *   Fetch a URL under the extension's identity, not the page's — bypasses the page's CORS
 *   policy. `options.url` must fall under one of this call's granted `match` patterns. A header
 *   value may reference a named secret instead of a plain string — see `secrets.use`.
 * - `synapseApi.files.save(options: SynapseFilesSaveOptions): Promise<SynapseFilesSaveResult>` — requires `files.save`.
 *   Write `options.content` to `options.filename` inside the Downloads folder.
 * - `synapseApi.net.mock.add(options: SynapseMockRuleOptions): Promise<{ id: string }>` — requires `net.mock`.
 *   Fake matching requests with a canned response. `options.endpointPattern` must have a literal
 *   (non-wildcard) scheme and host falling under one of this call's granted `match` patterns —
 *   only the path may use `*`; the mechanism (always the cheapest one) is chosen by the
 *   platform, not requested.
 * - `synapseApi.net.mock.remove(id: string): Promise<void>` — requires `net.mock`.
 *   Remove one of this script's own rules. Ids from another script or from the Management View
 *   are refused.
 * - `synapseApi.net.mock.list(): Promise<SynapseMockRule[]>` — requires `net.mock`.
 *   List this script's own rules — never another script's or the user's manually-created ones.
 * - `synapseApi.media.list(): Promise<SynapseMediaEntry[]>` — requires `media`.
 *   Every media file the network sniffer has detected so far — the same list the Side Panel
 *   shows.
 * - `synapseApi.media.inspect(url: string): Promise<SynapseMediaInspectResult>` — requires `media`.
 *   Fetch and parse an HLS manifest URL fresh (not a cached read).
 * - `synapseApi.media.download(options: SynapseMediaDownloadOptions): Promise<string>` — requires `media`.
 *   Start a download; returns the jobId immediately without waiting for completion.
 * - `synapseApi.media.job(jobId: string): Promise<SynapseMediaJobStatus | undefined>` — requires `media`.
 *   Poll a snapshot of a download started by media.download — no subscription exists
 *   (docs/api-inventory.md §4).
 * - `synapseApi.media.control(jobId: string, action: 'pause' | 'resume' | 'cancel' | 'stop-live'): Promise<void>` — requires `media`.
 *   Act on a job started by media.download.
 * - `synapseApi.media.onProgress(jobId: string, handler: (status: SynapseMediaJobStatus) => void): () => void` — requires `media` (runs in your own world — synchronous).
 *   Push updates for a job started by media.download, instead of polling job() — the first real
 *   use of the subscription mechanism docs/api-inventory.md §4 spiked (§6 item 8), confirmed on
 *   real Chrome. Runs in your own world, like ui.*, and never reaches this scope check the way
 *   job()/download() do (a function-valued handler cannot cross the RPC boundary at all).
 * - `synapseApi.pipeline.hook(slotName: 'media.correlate-url', options: SynapsePipelineHookOptions): Promise<() => void>` — requires `media` (runs in your own world — synchronous).
 *   Register a handler for a named platform-pipeline slot, scoped by match — a script overrides
 *   one step of a built-in pipeline instead of forking the whole feature (docs/ROADMAP.md §11.6
 *   Tier 2). Runs in your own world, like ui.*/media.onProgress, since a function-valued handler
 *   cannot cross the RPC boundary — internally calls the separate pipeline.register RPC method
 *   to persist {slotName, match}, which IS scope-checked; a denied registration never gets into
 *   the winner computation, so the locally-held handler here is simply never invoked.
 * - `synapseApi.page.eval(code: string, args?: unknown[]): Promise<unknown>` — requires `page.eval`.
 *   Run code in the page's own MAIN-world JS context (Tampermonkey's `unsafeWindow`, made an
 *   explicit call) — breaks the isolation the USER_SCRIPT world otherwise guarantees. `code`
 *   runs as an async function body; `args` become its own `args` parameter. Gated on the calling
 *   tab's REAL url falling under this call's granted `match` patterns — not a url the script
 *   provides.
 * - `synapseApi.ai.ask(options: SynapseAiAskOptions): Promise<SynapseAiAskResult>` — requires `net.request`.
 *   Thin {provider,model,messages} → text helper for OpenAI/Ollama chat completions — not a
 *   unified LLM abstraction, see the type doc comment. `options.baseUrl` (or the provider's
 *   default endpoint) must fall under one of this call's granted `net.request` `match` patterns,
 *   the same requirement calling that endpoint via `net.request` directly would carry. A
 *   `secretRef` additionally requires `secrets.use`, injected as `Authorization: Bearer
 *   <value>`.
 * - `synapseApi.lib.hls.parse(text: string, baseUrl: string): SynapseHlsManifest` — no scope required — pure computation (runs in your own world — synchronous).
 *   Parse an HLS (.m3u8) manifest already fetched by the script. No scope: pure computation on
 *   data the caller already has, granted no privilege (docs/api-inventory.md §3.0).
 * - `synapseApi.lib.readable(doc?: Document): { title, root, text } | undefined` — no scope required — pure computation (runs in your own world — synchronous).
 *   Extract the readable article from a Document via Mozilla Readability. Mutates `doc`; clones
 *   the page's own document when omitted. No scope — only meaningful where a page DOM exists,
 *   same as `ui`, but fails with a plain error rather than a crafted stub elsewhere.
 * - `synapseApi.lib.toMarkdown(root: Node, options: { baseUrl, resolveImageUrl? }): string` — no scope required — pure computation (runs in your own world — synchronous).
 *   Convert a DOM subtree to Markdown. No scope: pure computation on a Node the caller already
 *   has.
 * - `synapseApi.lib.zip(entries: { name, data }[]): Uint8Array` — no scope required — pure computation (runs in your own world — synchronous).
 *   Build an uncompressed .zip archive from named byte buffers. No scope: pure computation.
 * - `synapseApi.lib.matchPattern.isValid(pattern: string): boolean` — no scope required — pure computation (runs in your own world — synchronous).
 *   Whether pattern is well-formed Chrome match-pattern syntax. No scope: pure computation.
 * - `synapseApi.lib.matchPattern.test(url: string, pattern: string): boolean` — no scope required — pure computation (runs in your own world — synchronous).
 *   Whether url falls under pattern - the exact matcher net.request/net.mock enforce against. No
 *   scope: pure computation.
 * - `synapseApi.lib.matchPattern.testAny(url: string, patterns: string[]): boolean` — no scope required — pure computation (runs in your own world — synchronous).
 *   Whether url falls under any of patterns. No scope: pure computation.
 */

/**
 * A permission a script can be granted. Named after the purpose/resource, never after the
 * transport mechanism — a script declares what it wants to *do*, not which pipe it wants. `bus` is
 * deliberately absent and can never become a scope: `bus.emit(moduleId, …)` reaches every bundled
 * Module's own listener, which is a god-capability no consent prompt can describe honestly.
 */
type SynapseScope = 'storage.rw' | 'page.dom' | 'page.fetch' | 'ui.render' | 'net.request' | 'files.save' | 'net.mock' | 'media' | 'page.eval' | 'secrets.use';

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
interface SynapseUiApi {
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

/** A `net.request` header value naming a secret by reference instead of carrying it directly
 * (docs/ROADMAP.md §11.6's Secret Service) — the script declares which secret it wants and how to
 * shape the header around it, and never receives the resolved value in any form. `format` lets the
 * header be more than the bare secret (`'Bearer {}'`); `{}` is replaced with the resolved value at
 * the network boundary. Defaults to `'{}'` (the raw value). Requires the `secrets.use` scope in
 * addition to `net.request` itself — and even then, the referenced secret's own `allowedHost`
 * (bound once, at creation, in the Dashboard) must independently match `url`, regardless of what
 * `net.request`'s own `match` grant allows. */
interface SynapseNetSecretHeaderValue {
  secretRef: string;
  format?: string;
}

/** One outbound request for `net.request`. `match` in the granted scope is checked against `url`
 * before this ever reaches the network — a URL that doesn't fall under one of the script's granted
 * patterns fails at the call site, same as any other denied scope. */
interface SynapseNetRequestOptions {
  url: string;
  /** Defaults to `'GET'`. */
  method?: string;
  /** A value may be a plain string, or `{ secretRef, format? }` to have the platform inject a named
   * secret (`secrets.use`) without this script ever seeing it. */
  headers?: Record<string, string | SynapseNetSecretHeaderValue>;
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
interface SynapseNetResponse {
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
interface SynapseMockRuleOptions {
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
interface SynapseMockRule {
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
interface SynapseNetMockApi {
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
interface SynapseNetApi {
  request(options: SynapseNetRequestOptions): Promise<SynapseNetResponse>;
  mock: SynapseNetMockApi;
}

/** One file to write to disk. Scope: `files.save` — the delta a script cannot close on its own
 * (`GM_download` in the Tampermonkey world; there is no page API that writes to the filesystem). */
interface SynapseFilesSaveOptions {
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

interface SynapseFilesSaveResult {
  /** Chrome's own download id — usable with `chrome://downloads` but not with any `synapseApi`
   * method today; there is no `files.*` follow-up call yet (no progress/cancel). */
  downloadId: number;
}

interface SynapseFilesApi {
  save(options: SynapseFilesSaveOptions): Promise<SynapseFilesSaveResult>;
}

/** One variant listed by an HLS master playlist — itself another manifest URL, not a video. */
interface SynapseHlsManifestVariant {
  url: string;
  /** From `RESOLUTION=WxH`. Absent when the playlist doesn't advertise one (e.g. audio-only). */
  resolution?: string;
}

/** One `#EXT-X-KEY` tag's worth of info. `method !== 'AES-128'`, or any `keyFormat` other than
 * absent/`'identity'`, means real DRM (Widevine/PlayReady/FairPlay) — not something to decrypt. */
interface SynapseHlsSegmentKey {
  method: string;
  uri: string;
  iv?: string;
  keyFormat?: string;
}

interface SynapseHlsManifestSegment {
  url: string;
  key?: SynapseHlsSegmentKey;
  byteRange?: string;
}

/** What `lib.hls.parse` returns — mirrors `shared/media-manifest-parser.ts`'s `ParsedManifest`
 * exactly (duplicated here, not imported: this file must stay import-free, see the file banner). */
type SynapseHlsManifest =
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
interface SynapseLibApi {
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
  /** Chrome extension match-pattern syntax (`*://*.example.com/*` — the same shape `net.request`'s
   * `match` grants use, and Tampermonkey's `@connect`). Pure, no scope: this is the exact matcher
   * `net.request`/`net.mock` are enforced against, exposed rather than re-implemented, because its
   * edge cases (the `*.` subdomain-wildcard rule, `*` as scheme meaning http/https only) are easy to
   * get subtly wrong and NOT the same rules a standard `URLPattern` follows. Useful to pre-filter a
   * batch of candidate URLs against your own declared `match` list before firing `net.request` for
   * each one, instead of discovering the rejection at the call site one at a time. */
  matchPattern: {
    /** Whether `pattern` itself is well-formed Chrome match-pattern syntax. */
    isValid(pattern: string): boolean;
    /** Whether `url` falls under `pattern`. An unparseable `url` or `pattern` never matches. */
    test(url: string, pattern: string): boolean;
    /** Whether `url` falls under any of `patterns`. */
    testAny(url: string, patterns: string[]): boolean;
  };
}

/** A `synapseApi.media.list()`/`.download()`-eligible file the network sniffer already detected —
 * mirrors `features/media/store.ts`'s `DetectedMedia` (duplicated here, not imported: this file
 * must stay import-free, see the file banner), trimmed to the fields a script has any use for.
 * `requestHeaders` is deliberately excluded: it exists so Synapse's OWN later fetch of this URL can
 * replay a handful of allowlisted headers, not something a script needs to see or act on. */
interface SynapseMediaEntry {
  id: string;
  url: string;
  kind: 'video' | 'audio' | 'stream';
  pageUrl?: string;
  tabUrl?: string;
  /** ISO timestamp — display-only; list order is detection order. */
  detectedAt: string;
  thirdParty?: boolean;
  /** Best-effort signal the URL carries a signed/expiry query param (S3-style presigned URL, CDN
   * token-auth, …) — a label, not a filter: a legitimate file being served this way is normal. */
  expiring?: boolean;
  resolution?: string;
  /** Set once a `kind: 'stream'` entry has been auto-inspected and turned out to be a media/variant
   * playlist (not a master listing other resolutions) — segment count only, not the segment URLs
   * themselves (those are hundreds-long and go stale the moment a live manifest rotates). */
  segmentCount?: number;
  /** Set alongside `segmentCount` — real DRM (not the AES-128-with-clear-key case `media.download`
   * can handle), same distinction `SynapseHlsSegmentKey` documents for `lib.hls.parse`. */
  encrypted?: boolean;
  /** Set on a master-playlist `kind: 'stream'` entry once auto-inspected — one variant per
   * resolution the master lists, each its own downloadable media-playlist URL. */
  variants?: { url: string; resolution?: string }[];
}

/** What `media.inspect(url)` resolves to for an HLS (`.m3u8`) URL — a fresh fetch+parse, not a
 * cached read, so it reflects the manifest as it is right now. A master playlist populates only
 * `variants`; a media/variant playlist populates the rest; a URL that isn't parseable HLS resolves
 * to `{}` (all fields absent) — the same "honest primitive, no crafted fallback" posture as
 * `lib.readable`. DASH (`.mpd`) is out of scope, same as `lib.hls.parse` (docs/api-inventory.md §3.1). */
interface SynapseMediaInspectResult {
  /** Present only for a master playlist — each entry is another resolution's own media-playlist URL. */
  variants?: { url: string; resolution?: string }[];
  /** Present only for a media/variant playlist — segment count, not the segment URLs themselves. */
  segments?: number;
  encrypted?: boolean;
  /** A sliding-window (no `#EXT-X-ENDLIST`) playlist — `media.download` on one of these keeps
   * capturing until `media.control(jobId, 'stop-live')`, never reaching `'done'` on its own. */
  live?: boolean;
}

interface SynapseMediaDownloadOptions {
  url: string;
  /** Cosmetic label (e.g. `"1080p"`) — carried through to `media.job()`'s status for display only. */
  resolutionLabel?: string;
}

/** Mirrors the download engine's own phase names (`shared/download-engine-protocol.ts`'s
 * `DownloadEnginePhase`, duplicated here per this file's import-free constraint). `'pausing'` is the
 * honest in-between state between a `'pause'` control call and the engine actually reaching a quiet
 * point — up to one segment/chunk can still be genuinely in flight when the request arrives. */
type SynapseMediaDownloadPhase = 'segments' | 'chunks' | 'remux' | 'pausing' | 'paused' | 'done' | 'error' | 'cancelled';

/** What `media.job(jobId)` resolves to — a snapshot, not a subscription (docs/api-inventory.md §4:
 * a function-valued `onProgress` callback cannot cross the RPC boundary, so polling is the v1 answer
 * for every job-shaped API). `undefined` means this platform has no snapshot for `jobId` — either it
 * was never started via `media.download`, or the background service worker restarted since (the
 * snapshot is in-memory only, same "no persistence" posture `docs/ROADMAP.md §7.6` already commits
 * to for download progress). */
interface SynapseMediaJobStatus {
  phase: SynapseMediaDownloadPhase;
  done?: number;
  total?: number;
  /** Set only when `phase === 'error'`. */
  error?: string;
}

type SynapseMediaControlAction = 'pause' | 'resume' | 'cancel' | 'stop-live';

/**
 * Detect → inspect → download → poll → control, over media the network sniffer already found on
 * pages this script (or any other) ran on. Scope: `media`, no `match` dimension — unlike
 * `net.request`/`net.mock`, a grant is all-or-nothing, not scoped per origin (docs/api-inventory.md
 * §5: a script asking to see detected media is asking to see all of it, the same way the Side Panel
 * does).
 *
 * `download`/`job`/`control` are the id-based facade docs/api-inventory.md §3.1 calls for: the
 * engine itself deals in live objects (`AbortController`, an OPFS run) that cannot cross structured
 * clone, so every one of these methods takes or returns a plain `jobId` string instead.
 */
interface SynapseMediaApi {
  /** Every media file detected so far, most-recently-seen order. Same list the Side Panel shows. */
  list(): Promise<SynapseMediaEntry[]>;
  /** Fetches and parses an HLS manifest URL fresh — typically one of `list()`'s own entries, or one
   * of a master entry's `variants`. */
  inspect(url: string): Promise<SynapseMediaInspectResult>;
  /** Starts a download and returns its `jobId` immediately — does not wait for completion. Poll
   * `job(jobId)` for progress. `url` must classify as media by extension (`.m3u8`/`.mpd` run the
   * HLS/segment engine; `.mp4`/`.webm`/`.mp3`/… run the multi-connection direct-file downloader) —
   * anything else is refused before a job is created. */
  download(options: SynapseMediaDownloadOptions): Promise<string>;
  /** A snapshot of `jobId`'s current progress, or `undefined` if there is none to report (see
   * `SynapseMediaJobStatus`'s own doc comment for why "none" is a legitimate, non-error answer). */
  job(jobId: string): Promise<SynapseMediaJobStatus | undefined>;
  /** Acts on a job started by `download()`. `'stop-live'` only makes sense for a live capture (a
   * sliding-window manifest with no `#EXT-X-ENDLIST`) and is a no-op otherwise. */
  control(jobId: string, action: SynapseMediaControlAction): Promise<void>;
  /**
   * Push updates for a job started by `download()`, instead of polling `job()` — the first real
   * consumer of the subscription mechanism docs/api-inventory.md §4 spiked (§6 item 8).
   * **Synchronous, and takes a closure — like `ui`, not like the rest of `media`**: this never
   * crosses the RPC boundary (a function-valued `handler` cannot survive structured clone), so the
   * platform registers it in your own world and only ever pushes the already-serializable
   * `SynapseMediaJobStatus` across. Returns an unsubscribe function.
   *
   * **Delivery into the USER_SCRIPT world is confirmed working on real Chrome** — the platform CAN
   * push into that world (docs/api-inventory.md §6 item 8's write-up has the mechanism); `job(jobId)`
   * polling remains available as a fallback (a background service-worker restart between the push
   * and your handler still loses in-flight events, same as any other in-memory-only state here), but
   * is no longer the only working path.
   */
  onProgress(jobId: string, handler: (status: SynapseMediaJobStatus) => void): () => void;
}

/**
 * Runs `code` directly in the page's own MAIN-world JS context — Tampermonkey's `unsafeWindow`,
 * made an explicit call instead of an ambient global (docs/api-inventory.md §2, §6 item 7). Scope:
 * `page.eval`, always carries `match` — but unlike every other `requiresMatch` scope, the resource
 * checked is not something passed as an argument: it is whichever tab this call is actually running
 * on, read from the platform's own record of the sender, so a script cannot claim a different origin
 * than the one it is really calling from.
 *
 * The highest-privilege scope in the catalog and the only one with no partial version: once granted
 * for a domain, `code` runs with the full authority of that page's own JS context — every global,
 * every cookie-backed fetch, every DOM mutation a hand-authored `<script>` tag on that page could
 * do. There is no sandboxing inside `code` itself.
 *
 * Same structured-clone rules as every other `rpc` method (see the file banner): `args` and
 * whatever `code` `return`s must both survive it — no functions, no DOM nodes, no live objects.
 * `code` runs as the body of an async function, so `await` works inside it.
 *
 * **Best-effort, not a bypass**: a page whose `script-src` CSP excludes `unsafe-eval` will reject
 * the `Function` construction this relies on, and the call rejects with that page's own CSP error
 * instead of running — v1 has no workaround for that (docs/api-inventory.md §7).
 */
interface SynapsePageApi {
  /** Runs synchronously to the extent `code` itself is synchronous, but always resolves the same
   * way `net.request` etc. does: an async round trip, whether or not `code` itself awaits anything.
   * `args` are passed through as `code`'s own `args` parameter. */
  eval(code: string, args?: unknown[]): Promise<unknown>;
}

/** The two providers `ai.ask` speaks natively (docs/ROADMAP.md §11.6). Deliberately NOT an
 * extensible string: "unified LLM interface" is the hole this method exists to avoid — anything
 * beyond these two shapes is `net.request` + `secretRef`, not a third branch grafted on here. */
type SynapseAiProvider = 'openai' | 'ollama';

interface SynapseAiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface SynapseAiAskOptions {
  provider: SynapseAiProvider;
  model: string;
  messages: SynapseAiMessage[];
  /** Names a secret (`secrets.use`) whose value is injected as `Authorization: Bearer <value>` at
   * the network boundary — this script never sees it, same mechanism `net.request`'s own
   * `{secretRef}` header value uses. Required for `'openai'` (no key, no request); ignored for
   * `'ollama'` (a local server, no auth) even if given. */
  secretRef?: string;
  /** Overrides the provider's default endpoint — a self-hosted Ollama on a non-default host/port,
   * or an OpenAI-compatible proxy. Still checked against this call's own granted `net.request`
   * `match` (see `SynapseAiApi`'s doc comment on why that's the gating scope). Defaults:
   * `'https://api.openai.com/v1/chat/completions'` (openai), `'http://localhost:11434/api/chat'`
   * (ollama). */
  baseUrl?: string;
  /** Defaults to 30s, capped at 120s — same cap as `net.request`. */
  timeoutMs?: number;
}

interface SynapseAiAskResult {
  text: string;
}

/**
 * `{provider, model, messages} → text` — a thin helper over the two chat-completion shapes worth
 * saving a script from re-typing by hand, not an agent and not a unified abstraction over every LLM
 * API (docs/ROADMAP.md §11.6). No scope of its own: gated on `net.request`, the same scope a script
 * would need to call the provider's endpoint directly — `ai.ask` only shapes the request and
 * extracts the reply text, it does not open a door `net.request` + `secretRef` didn't already open,
 * so it does not get a second one.
 *
 * **v1 does not stream.** `chrome.runtime.sendMessage`'s reply is one value, not a stream — a
 * streaming variant would need `chrome.runtime.connect`, not attempted here.
 */
interface SynapseAiApi {
  ask(options: SynapseAiAskOptions): Promise<SynapseAiAskResult>;
}

/**
 * Tier 2 composition (docs/ROADMAP.md §11.6 item 8, `.claude/skills/userscript-api` "Composition"):
 * a platform pipeline declares a named *slot*; a script overrides it for the pages it cares about
 * via `match`, instead of forking the whole feature. **Synchronous-feeling but takes a closure —
 * like `ui`/`media.onProgress`, not like the rest of the facade**: `handler` never crosses the RPC
 * boundary (a function-valued parameter cannot survive structured clone), so it runs entirely in
 * your own world, and only its already-serializable *return value* is relayed back to the platform.
 *
 * **Conflict rule** when more than one script hooks the same slot for an overlapping URL: the more
 * specific `match` pattern wins; a tie breaks by script order the user has configured (today: a
 * placeholder — no such setting exists yet, see docs/ROADMAP.md); registration order never decides
 * anything.
 *
 * v1 has exactly one slot. Extend `SynapsePipelineHookOptions`'s `slotName`/ctx/result union when a
 * second one ships — do not generalize ahead of a second real caller.
 */
interface SynapseMediaCorrelateUrlCtx {
  /** The page this slot fired on — match your `handler`'s own site-specific logic against this,
   * not against `location.href` read fresh (the two are the same value here, but reading the one
   * you were given is what makes a future slot with a different `ctx` shape safe to add without
   * silently changing this one's contract). */
  pageUrl: string;
}

interface SynapseMediaCorrelateUrlResult {
  /** CSS selector identifying the `<video>`/`<audio>` element this `url` belongs to. Re-resolved by
   * the platform against the live page DOM after `handler` returns — the element itself never
   * crosses the world boundary, only this selector does. An entry whose selector no longer resolves
   * (the page changed between fire and response) is skipped, not an error. */
  cssSelector: string;
  url: string;
}

interface SynapsePipelineHookOptions {
  match: string[];
  /** Called with the fired slot's `ctx` when this script wins the conflict resolution for the
   * current page. Return the media URLs your own site-specific logic found — an empty array or a
   * thrown error both mean "nothing found", never a hang (see `pipeline.hook`'s own doc comment on
   * `SynapsePipelineApi`). */
  handler: (ctx: SynapseMediaCorrelateUrlCtx) => SynapseMediaCorrelateUrlResult[] | Promise<SynapseMediaCorrelateUrlResult[]>;
}

interface SynapsePipelineApi {
  /** Registers `options.handler` for `slotName` on the pages matched by `options.match`. Resolves
   * once the registration is accepted (rejects if the required scope — reused from whichever
   * feature owns the slot, `media` for `'media.correlate-url'` — isn't granted) to an unsubscribe
   * function; call it to release the slot early (a fresh page load re-registers anyway, since
   * top-level script code runs again on every navigation). */
  hook(slotName: 'media.correlate-url', options: SynapsePipelineHookOptions): Promise<() => void>;
}

/** The facade every caller programs against, delivered as `ctx.api`: to bundled Modules from the
 * Kernel, to uploaded user scripts from the shim. One interface, three transports (in-process /
 * content-script RPC / user script shim) — a method reachable from one but not another is a
 * contract break, not a gap. Deliberately never a global: uploaded scripts share one execution
 * world, so a global name has one binding for all of them and could not identify the caller. */
interface SynapseApi {
  storage: SynapseStorageApi;
  /** Only usable from code that runs on a page. A background Module gets a stub whose every method
   * throws with that explanation — there is no DOM in a service worker to render into. */
  ui: SynapseUiApi;
  net: SynapseNetApi;
  files: SynapseFilesApi;
  lib: SynapseLibApi;
  media: SynapseMediaApi;
  /** Only usable from code that runs on a page, same as `ui` — a background Module gets a stub
   * whose method throws with that explanation, since "the page's MAIN world" has no meaning for
   * code that isn't attached to any tab. */
  page: SynapsePageApi;
  ai: SynapseAiApi;
  pipeline: SynapsePipelineApi;
}

/** One step of a multi-step script (docs/ROADMAP.md §12.3) — the uploaded-script equivalent of a
 * bundled Composite Module's sub-module (`kernel/composite-module.ts`). Steps run in array order,
 * each one's resolved value becoming the next one's `input`, exactly like `createCompositeModule`:
 * sequential only, no rollback — a step that throws is reported (Studio's sidebar shows which one
 * and why) and the NEXT step still runs with the previous value unchanged. */
interface SynapseUserScriptStep {
  /** Stable identity for this step. Prefer a short literal string constant (e.g. `'load-dom'`):
   * the Studio sidebar locates a step's definition by searching your saved source text for this
   * exact literal to jump the editor to it, so an id computed at runtime can be listed but never
   * jumped to. Also the key for this step's per-run bypass toggle (`RegistryEntry.subState`). */
  id: string;
  /** Shown in the Studio sidebar and the popup's tooltip instead of the raw id. */
  label?: string;
  run(input: unknown, ctx: { api: SynapseApi }): Promise<unknown>;
}

/** What an uploaded user script assigns to `__synapseModule` to declare itself. Assign the bare
 * name, not `globalThis.__synapseModule` — both create the same global at runtime (the shim wraps
 * user source in a non-strict IIFE, so a bare undeclared assignment becomes an implicit global same
 * as `globalThis.x =` would), but only the bare form gets contextual typing from this file when
 * loaded into an editor via TS's `addExtraLib` (`declare let __synapseModule: ...` below doesn't
 * attach to `globalThis`'s type — a top-level `let`/`const` never does, matching real JS semantics). */
interface SynapseUserScriptManifest {
  /** Display label only. The extension assigns the canonical routing id at upload time, before
   * this script has ever run, so this can never be a routing or storage key. */
  id: string;
  /** Requested scopes. This is a *request*: the grant record the user approved is the authority,
   * and it is re-checked in the background on every single call. */
  scopes?: (SynapseScope | SynapseScopeGrant)[];
  /**
   * Declare exactly one of `run`/`steps` (docs/ROADMAP.md §12.3) — declaring both, or neither, is
   * `invalid`. A bare `run` is really `steps: [{ id: 'main', run }]` in disguise: the platform
   * normalizes it to that shape internally, so every uploaded script is "a pipeline of N≥1 steps"
   * from the Registry's point of view, and the single-step case is not a special case anywhere
   * downstream. Declare `steps` directly once your script grows past one logical stage — the
   * Studio sidebar then shows each step's last run status and lets the user bypass it individually,
   * without touching this file's `run`.
   */
  run?(input: unknown, ctx: { api: SynapseApi }): Promise<unknown>;
  /** Two or more steps, each with a unique `id`. See `run`'s doc comment above — declare one or
   * the other, never both. */
  steps?: SynapseUserScriptStep[];
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
