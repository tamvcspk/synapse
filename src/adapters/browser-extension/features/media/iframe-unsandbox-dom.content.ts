/**
 * Content-script infra (docs/ROADMAP.md #4, Part C) for the `iframe-unsandbox` Module — a sandboxed
 * `<iframe sandbox="...">` missing `allow-scripts` runs NO scripts at all inside it, including this
 * extension's own content scripts, so nothing installed *inside* that frame could ever fix it from
 * within. The fix has to come from the PARENT frame that embeds it, widening the `sandbox` token
 * list on the `<iframe>` element itself, before/as it loads.
 *
 * Every frame (this file is loaded via frame-media-observer.content.ts's `all_frames: true` entry) fixes
 * only its own direct `<iframe>` children — this cascades correctly through arbitrary nesting depth:
 * once a child is unsandboxed, the browser injects this same content script into it, which then
 * fixes its own children, and so on.
 *
 * Deliberately does NOT touch `Content-Security-Policy` response headers — a server-declared
 * `sandbox` directive on the framed document itself isn't a DOM attribute, so no DOM mutation can
 * fix that case; see features/media/iframe-unsandbox.background.ts's DNR rule for that half.
 */

const REQUIRED_TOKENS = ['allow-scripts', 'allow-same-origin'];

function fixIframe(iframe: Element): void {
  if (!(iframe instanceof HTMLIFrameElement) || !iframe.hasAttribute('sandbox')) return;
  // Only ADDS the missing tokens needed for a content script to run — never removes/replaces the
  // attribute wholesale, so any other restriction the site set (e.g. allow-popups) is left as-is.
  for (const token of REQUIRED_TOKENS) {
    if (!iframe.sandbox.contains(token)) iframe.sandbox.add(token);
  }
}

function scanIframes(): void {
  document.querySelectorAll('iframe[sandbox]').forEach(fixIframe);
}

export function installIframeUnsandbox(): void {
  scanIframes();

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && mutation.target instanceof Element) {
        fixIframe(mutation.target);
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node instanceof HTMLIFrameElement) fixIframe(node);
        node.querySelectorAll('iframe[sandbox]').forEach(fixIframe);
      }
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['sandbox'],
  });
}
