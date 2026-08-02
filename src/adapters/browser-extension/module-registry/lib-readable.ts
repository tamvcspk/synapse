import { Readability } from '@mozilla/readability';

/**
 * Backs `synapseApi.lib.readable` (docs/api-inventory.md §3.0/§3.4) — shared by every transport
 * that can construct a real one (`user-script-lib-payload.ts`'s USER_SCRIPT-world payload,
 * `synapse-api-host.ts`'s background in-process transport, `content-scripts/rpc-client.ts`'s dom
 * Module transport, `kernel/service-injector.ts`'s fallback stub) rather than duplicated four times
 * — unlike `utils/ui-compositor.ts`, there is no ESM-availability wall forcing a copy in this case,
 * all four contexts are plain ESM.
 *
 * Deliberately NOT in `shared/` (docs/design.md §9's Global SDK): that layer's own rule is "no
 * global reads of its own" (see `shared/html-to-markdown.ts`'s doc comment), and this function reads
 * the global `document` when `doc` is omitted. `module-registry/` is the right home — an
 * environment-specific helper, not a portable-everywhere one.
 */
export function readable(doc?: Document): { title: string; root: Element; text: string } | undefined {
  const target = doc ?? (document.cloneNode(true) as Document);
  const reader = new Readability<Element>(target, { serializer: (el) => el as unknown as Element });
  const article = reader.parse();
  if (!article?.content) return undefined;
  return { title: article.title || '', root: article.content, text: article.textContent || '' };
}
