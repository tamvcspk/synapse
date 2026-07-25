/**
 * MAIN-world mechanism (Environment SDK — see the sdk-layers skill's mechanism-vs-policy rule) that
 * wraps a page-exposed `window.Hls` constructor (hls.js's UMD browser global) to learn a manifest
 * URL <-> `<video>` element pairing with NO correlation-window guessing (docs/ROADMAP.md #7.3
 * (a-hls)) — `Hls.Events.MANIFEST_LOADED` hands both directly (`data.url`, the firing instance's
 * own `.media`).
 *
 * Narrower than media-source-interceptor.ts's generic hook above: only fires when the page happens
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
  Events?: { MANIFEST_LOADED?: string };
}

function isHlsLikeConstructor(value: unknown): value is HlsLikeConstructor {
  return typeof value === 'function';
}

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
        this.on(manifestLoadedEvent, (_event, data) => {
          if (this.media) onManifestLoaded({ url: data.url, media: this.media });
        });
      } catch {
        // Best-effort — never let our hook crash the page's own player.
      }
    }
  }
  return WrappedHls as unknown as HlsLikeConstructor;
}

/** Idempotent-by-convention: call once, before the page's own script can run. No-ops (never throws)
 * if `window.Hls` turns out not to be a constructor, or if redefining the property is rejected
 * (e.g. the page already froze it) — same "graceful absence" posture as media-source-interceptor.ts. */
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
