import type { Module } from '../../../../../kernel/module';
import { syncDnrRules, clearDnrRules, type DnrRuleSpec } from '../../../utils/dnr-network-rules';
import { isModuleActive } from '../../../module-registry/storage';

/**
 * Background Module (docs/ROADMAP.md #4, Part C) — a standalone, off-by-default toggle, deliberately
 * NOT folded into network-sniffer's on/off switch. No `uiSchema` (no config to show) — gets only the
 * Slide Toggle every Module without one already gets (docs/ROADMAP.md §2's Navigation Flow).
 *
 * Two independent halves, both gated on this Module's own active state:
 * - DOM half: content-scripts/iframe-unsandbox-dom.ts widens a sandboxed <iframe>'s token list
 *   (parent-side DOM mutation) — fixes the case where the PARENT page itself set `sandbox`.
 * - Network half (this file): a single, always-on DNR rule stripping the `Content-Security-Policy`
 *   response header from every `sub_frame` response while active — fixes the case where the framed
 *   document's OWN response declares a `sandbox` CSP directive, which no DOM mutation can touch.
 *
 * The DNR rule is deliberately BLANKET (every sub_frame response, every site) rather than scoped to
 * "only when it would have actually blocked us" — declarativeNetRequest can condition a rule on a
 * header's *name* but never its *value/content*, so there's no way to detect "this particular CSP
 * would have sandboxed us" and strip only then. This is why the trade-off is called out this
 * prominently and why the toggle is separate from network-sniffer: turning this on weakens
 * sandbox/CSP protection on every iframe on every site visited while it's active — including ones
 * with nothing to do with media (ads, payment widgets, embedded third-party tools), whose
 * sandboxing may exist for reasons unrelated to blocking extensions.
 */
const CSP_STRIP_SPEC: DnrRuleSpec = {
  id: 'strip-csp',
  urlRegex: '.*',
  resourceTypes: [chrome.declarativeNetRequest.ResourceType.SUB_FRAME],
  action: {
    kind: 'headers-only',
    responseHeaders: { 'content-security-policy': { operation: 'remove' } },
  },
};

export const IframeUnsandboxModule: Module<unknown, void> = {
  id: 'iframe-unsandbox',
  label: 'Iframe Unsandbox (CSP strip)',
  description:
    'Off by default. Lets network-sniffer see media inside sandboxed/CSP-restricted iframes — at the cost of stripping the Content-Security-Policy response header from every iframe on every site while this is on.',
  needs: ['bus'],
  async run() {
    if (await isModuleActive('iframe-unsandbox')) {
      await syncDnrRules('iframe-unsandbox', [CSP_STRIP_SPEC]);
    } else {
      await clearDnrRules('iframe-unsandbox');
    }
  },
};
