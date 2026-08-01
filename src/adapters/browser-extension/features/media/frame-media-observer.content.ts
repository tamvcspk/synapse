import { installDomMediaObserver } from './dom-media-observer.content';
import { installIframeUnsandbox } from './iframe-unsandbox-dom.content';
import { isModuleActive } from '../../module-registry/storage';

/**
 * Entry point for the second, `all_frames: true` content_scripts entry (manifest.config.ts,
 * docs/ROADMAP.md #4) — runs in every frame of every page, including nested/cross-origin iframes,
 * unlike content-scripts/index.ts's entry (top-frame-only, on purpose — see that file's comment).
 * Each frame instance only ever reads/mutates its own local DOM.
 *
 * Two independently-toggleable installers, gated on two separate Modules' active state:
 * - installDomMediaObserver (network-sniffer) — passive detection, safe, on by default once that
 *   Module is active.
 * - installIframeUnsandbox (iframe-unsandbox) — mutates sandboxed <iframe> elements found in this
 *   frame's own DOM; a separate, off-by-default Module (not bundled into network-sniffer) because
 *   of its much broader security trade-off (see that Module's doc comment).
 */
void (async () => {
  if (await isModuleActive('network-sniffer')) installDomMediaObserver();
  if (await isModuleActive('iframe-unsandbox')) installIframeUnsandbox();
})();
