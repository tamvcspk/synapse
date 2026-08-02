/**
 * Chrome extension match-pattern syntax (`*://*.example.com/*`) — the same shape Tampermonkey's
 * `@connect` and `manifest.json`'s `host_permissions`/`content_scripts.matches` use. This is the
 * resource dimension of a `SynapseScopeGrant` (docs/ROADMAP.md §11.3 constraint B,
 * `.claude/skills/userscript-api`): a grant is (action × origin), not action alone.
 *
 * Deliberately NOT the glob matcher `shared/http-mock.ts`'s `endpointPatternToRegexSource` uses —
 * that one is a plain substring glob against a URL string, with no concept of scheme/host
 * structure, so `*.evil.com*example.com*` would satisfy it against `https://example.com.evil.com/`.
 * A permission boundary needs the real thing: scheme, host (with the `*.` subdomain-wildcard rule),
 * and path matched as separate fields, the same way Chrome itself parses `host_permissions`.
 */

interface ParsedPattern {
  scheme: string;
  host: string;
  path: string;
}

const PATTERN_RE = /^(\*|[a-zA-Z][a-zA-Z0-9+.-]*):\/\/(\*|\*\.[^/*]+|[^/*]+)(\/.*)$/;

function parsePattern(pattern: string): ParsedPattern | undefined {
  const m = PATTERN_RE.exec(pattern);
  if (!m) return undefined;
  const [, scheme, host, path] = m as unknown as [string, string, string, string];
  return { scheme, host, path };
}

export function isValidMatchPattern(pattern: string): boolean {
  return parsePattern(pattern) !== undefined;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function hostMatches(host: string, patternHost: string): boolean {
  if (patternHost === '*') return true;
  if (patternHost.startsWith('*.')) {
    const bareDomain = patternHost.slice(2);
    return host === bareDomain || host.endsWith(`.${bareDomain}`);
  }
  return host === patternHost;
}

function pathMatches(path: string, patternPath: string): boolean {
  const source = `^${patternPath.split('*').map(escapeRegExp).join('.*')}$`;
  return new RegExp(source).test(path);
}

/** Whether `url` is covered by one match pattern. An unparseable `url` or `pattern` never matches —
 * this is an enforcement primitive, so the failure mode on garbage input is "deny", not "throw". */
export function matchesUrlPattern(url: string, pattern: string): boolean {
  const parsed = parsePattern(pattern);
  if (!parsed) return false;

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }

  const scheme = target.protocol.slice(0, -1); // "https:" -> "https"
  if (parsed.scheme === '*') {
    if (scheme !== 'http' && scheme !== 'https') return false; // Chrome's own `*` scheme rule
  } else if (parsed.scheme !== scheme) {
    return false;
  }

  if (!hostMatches(target.host, parsed.host)) return false;
  return pathMatches(`${target.pathname}${target.search}`, parsed.path);
}

export function matchesAnyPattern(url: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesUrlPattern(url, pattern));
}
