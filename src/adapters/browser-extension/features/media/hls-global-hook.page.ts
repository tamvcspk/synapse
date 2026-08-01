/**
 * MAIN-world mechanism (Environment SDK — see the sdk-layers skill's mechanism-vs-policy rule) that
 * wraps a page-exposed `window.Hls` constructor (hls.js's UMD browser global) to learn a manifest
 * URL <-> `<video>` element pairing with NO correlation-window guessing (docs/ROADMAP.md #7.3
 * (a-hls)) — `Hls.Events.MANIFEST_LOADED` hands both directly (`data.url`, the firing instance's
 * own `.media`).
 *
 * Narrower than media-source-interceptor.page.ts's generic hook above: only fires when the page happens
 * to expose `window.Hls` as a global (common for a simple `<script src=".../hls.min.js">` include,
 * absent for a player whose own bundler keeps hls.js internal with no global at all) — a supplement
 * for a better-than-heuristic result when available, not a replacement for the generic mechanism.
 *
 * `class WrappedHls extends OriginalHls` (not a hand-rolled Proxy) is what preserves every static
 * member (`Hls.Events`, `Hls.isSupported()`, ...) for free — `extends` sets up the prototype chain
 * for statics too, so anything the page reads off `Hls.*` after this runs still resolves through to
 * the original class untouched; only `new Hls(...)` itself is intercepted.
 *
 * Installed via an accessor property on `window.Hls` (not a one-time check) because this MAIN-world
 * script runs at `document_start`, before the page's own `<script>` tag that actually assigns
 * `window.Hls` has even loaded — the setter below catches that later assignment and wraps it before
 * the page ever calls `new Hls()`. Wrapped in try/catch throughout: this is duck-typing an external
 * library's runtime shape, and a version mismatch or unexpected page behavior must never crash the
 * player itself.
 */

interface HlsLikeInstance {
  media?: HTMLMediaElement | null;
  on(event: string, handler: (event: string, data: { url: string }) => void): void;
}

interface HlsLikeConstructor {
  new (...args: never[]): HlsLikeInstance;
  Events?: { MANIFEST_LOADED?: string; MEDIA_ATTACHED?: string };
}

function isHlsLikeConstructor(value: unknown): value is HlsLikeConstructor {
  return typeof value === 'function';
}

/** Two real bugs found via live testing, both fixed here:
 *
 * (1) A page that calls `hls.loadSource(url)` BEFORE `hls.attachMedia(video)` (one of hls.js's two
 * documented call orders — `loadSource`'s manifest fetch is async, so `MANIFEST_LOADED` can easily
 * fire before `attachMedia` ever runs) used to drop the correlation silently — the old code only
 * checked `this.media` at the exact instant `MANIFEST_LOADED` fired, with no retry once
 * `attachMedia` actually happened later. Fixed by also listening for `Hls.Events.MEDIA_ATTACHED`
 * and calling `tryFire` from both handlers — whichever arrives second is what actually fires.
 *
 * (2) `tryFire` used to be a ONE-SHOT per `Hls` instance (an early version latched on a `fired`
 * boolean). That's wrong: a real player commonly reuses the SAME `Hls` instance across multiple
 * videos (playlist/queue auto-advance, switching videos without a full page reload) — each later
 * `MANIFEST_LOADED` is a genuinely NEW video and must update the correlation, not be ignored. The
 * observed symptom was the badge staying bound to the FIRST video's now-stale/expired manifest URL
 * forever ("File wasn't available" on download), while a SEPARATE, correctly-detected entry for the
 * actual current video showed up via the independent `chrome.webRequest` path instead. Fixed by
 * just removing the latch — `tryFire` now re-fires on every `MANIFEST_LOADED`, keeping the
 * attribute (and the rescan signal, see constants.ts) current. Firing an identical
 * `{url, media}` pair twice in a row (e.g. both handlers firing in the same tick) is harmless — the
 * caller's `setAttribute`+channel-dispatch are idempotent for an unchanged value. */
function wrap(
  OriginalHls: HlsLikeConstructor,
  onManifestLoaded: (event: { url: string; media: HTMLMediaElement }) => void,
): HlsLikeConstructor {
  class WrappedHls extends (OriginalHls as unknown as new (...args: never[]) => HlsLikeInstance) {
    constructor(...args: never[]) {
      super(...args);
      try {
        const manifestLoadedEvent = OriginalHls.Events?.MANIFEST_LOADED;
        if (!manifestLoadedEvent) return;

        let manifestUrl: string | undefined;
        const tryFire = () => {
          if (manifestUrl === undefined || !this.media) return;
          onManifestLoaded({ url: manifestUrl, media: this.media });
        };

        this.on(manifestLoadedEvent, (_event, data) => {
          manifestUrl = data.url;
          tryFire();
        });

        const mediaAttachedEvent = OriginalHls.Events?.MEDIA_ATTACHED;
        if (mediaAttachedEvent) this.on(mediaAttachedEvent, () => tryFire());
      } catch {
        // Best-effort — never let our hook crash the page's own player.
      }
    }
  }
  return WrappedHls as unknown as HlsLikeConstructor;
}

/** Idempotent-by-convention: call once, before the page's own script can run. No-ops (never throws)
 * if `window.Hls` turns out not to be a constructor, or if redefining the property is rejected
 * (e.g. the page already froze it) — same "graceful absence" posture as media-source-interceptor.page.ts. */
export function installHlsGlobalHook(onManifestLoaded: (event: { url: string; media: HTMLMediaElement }) => void): void {
  try {
    let current: unknown = (window as { Hls?: unknown }).Hls;
    if (isHlsLikeConstructor(current)) current = wrap(current, onManifestLoaded);

    Object.defineProperty(window, 'Hls', {
      configurable: true,
      get: () => current,
      set: (value: unknown) => {
        current = isHlsLikeConstructor(value) ? wrap(value, onManifestLoaded) : value;
      },
    });
  } catch {
    // e.g. window.Hls already a non-configurable property — leave the page's player unhooked
    // rather than throwing into page code.
  }
}
