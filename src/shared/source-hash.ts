/**
 * Content hash of a user script's source, used to tie a grant to the exact code the user approved
 * (docs/ROADMAP.md §11.3 constraint D). SHA-256 via WebCrypto — available in every context this
 * runs in (service worker, content script, extension page) and in Node for the tests.
 *
 * Not a cheap non-cryptographic hash: this decides whether previously-approved permissions still
 * apply, so "two different sources collide" must not be something an author can arrange.
 */
export async function hashScriptSource(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
