/**
 * Global SDK (docs/design.md §9): pure string transform, no DOM/chrome APIs/I/O. Extracted out of
 * `ui/review/main.ts` once `reader-mode-converter.module.ts` (content-script) needed the same
 * logic too, for deriving a crawled page's file path from its URL (docs/ROADMAP.md #1).
 */

// Unicode "Combining Diacritical Marks" block — covers the tone/vowel marks NFD below decomposes
// Vietnamese letters into (grave, breve, horn, circumflex, ...). Written as numeric bounds rather
// than a regex character class literal to avoid embedding the actual combining characters in this
// source file (indistinguishable from each other at a glance, easy to mis-paste/mis-copy).
const COMBINING_MARK_MIN = 0x0300;
const COMBINING_MARK_MAX = 0x036f;

/** Strips diacritics before the a-z/0-9 filter below, so e.g. "Lan dau cong bo" (from "Lần đầu
 * công bố") survives instead of every accented letter being dropped outright, which used to leave
 * only stray consonants (e.g. "l-n-u-c-ng-b"). NFD decomposes most Vietnamese letters into a base
 * letter + combining mark, filtered out here by code point; "d with stroke" (đ/Đ) doesn't have a
 * canonical decomposition (it's its own letter, not base+mark), so it's replaced explicitly. */
function stripDiacritics(text: string): string {
  return Array.from(text.normalize('NFD'))
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < COMBINING_MARK_MIN || code > COMBINING_MARK_MAX;
    })
    .join('')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

/** Kebab-cases arbitrary text into a filesystem/URL-safe slug — e.g. "Lần đầu công bố dữ liệu" →
 * "lan-dau-cong-bo-du-lieu". `fallback` is returned when the input has nothing left after
 * stripping (empty string, or entirely punctuation/symbols). */
export function slugify(text: string, fallback = 'untitled'): string {
  const slug = stripDiacritics(text)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}
