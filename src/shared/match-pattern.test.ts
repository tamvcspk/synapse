import { describe, expect, it } from 'vitest';
import { isValidMatchPattern, matchesAnyPattern, matchesUrlPattern } from './match-pattern';

describe('matchesUrlPattern', () => {
  it('matches an exact scheme/host/path', () => {
    expect(matchesUrlPattern('https://api.example.com/v1/x', 'https://api.example.com/v1/*')).toBe(true);
    expect(matchesUrlPattern('https://api.example.com/v2/x', 'https://api.example.com/v1/*')).toBe(false);
  });

  it('treats scheme "*" as http-or-https only, not file/ftp/chrome-extension', () => {
    expect(matchesUrlPattern('https://a.test/x', '*://a.test/*')).toBe(true);
    expect(matchesUrlPattern('http://a.test/x', '*://a.test/*')).toBe(true);
    expect(matchesUrlPattern('file:///a.test/x', '*://a.test/*')).toBe(false);
  });

  it('matches host "*" against any host', () => {
    expect(matchesUrlPattern('https://anything.example/x', '*://*/*')).toBe(true);
  });

  it('matches "*.example.com" against the bare domain and any subdomain, never a lookalike suffix', () => {
    expect(matchesUrlPattern('https://example.com/x', '*://*.example.com/*')).toBe(true);
    expect(matchesUrlPattern('https://api.example.com/x', '*://*.example.com/*')).toBe(true);
    expect(matchesUrlPattern('https://deep.api.example.com/x', '*://*.example.com/*')).toBe(true);
    expect(matchesUrlPattern('https://notexample.com/x', '*://*.example.com/*')).toBe(false);
    expect(matchesUrlPattern('https://example.com.evil.com/x', '*://*.example.com/*')).toBe(false);
  });

  it('matches an exact host with no subdomain allowance', () => {
    expect(matchesUrlPattern('https://example.com/x', '*://example.com/*')).toBe(true);
    expect(matchesUrlPattern('https://api.example.com/x', '*://example.com/*')).toBe(false);
  });

  it('matches path glob, including the query string', () => {
    expect(matchesUrlPattern('https://a.test/search?q=1', 'https://a.test/search*')).toBe(true);
    expect(matchesUrlPattern('https://a.test/other?q=1', 'https://a.test/search*')).toBe(false);
  });

  it('requires the full path when the pattern has no trailing wildcard', () => {
    expect(matchesUrlPattern('https://a.test/exact', 'https://a.test/exact')).toBe(true);
    expect(matchesUrlPattern('https://a.test/exact/more', 'https://a.test/exact')).toBe(false);
  });

  it('denies rather than throws on an unparseable url or pattern', () => {
    expect(matchesUrlPattern('not a url', 'https://a.test/*')).toBe(false);
    expect(matchesUrlPattern('https://a.test/x', 'not-a-pattern')).toBe(false);
    expect(matchesUrlPattern('https://a.test/x', 'https://a.test')).toBe(false); // path must start with "/"
  });
});

describe('matchesAnyPattern', () => {
  it('matches if any pattern in the list matches', () => {
    expect(matchesAnyPattern('https://b.test/x', ['https://a.test/*', 'https://b.test/*'])).toBe(true);
    expect(matchesAnyPattern('https://c.test/x', ['https://a.test/*', 'https://b.test/*'])).toBe(false);
  });

  it('matches nothing against an empty pattern list', () => {
    expect(matchesAnyPattern('https://a.test/x', [])).toBe(false);
  });
});

describe('isValidMatchPattern', () => {
  it('accepts well-formed patterns', () => {
    expect(isValidMatchPattern('*://*.example.com/*')).toBe(true);
    expect(isValidMatchPattern('https://a.test/*')).toBe(true);
    expect(isValidMatchPattern('https://a.test/')).toBe(true);
  });

  it('rejects malformed patterns', () => {
    expect(isValidMatchPattern('example.com')).toBe(false);
    expect(isValidMatchPattern('https://a.test')).toBe(false); // missing path
    expect(isValidMatchPattern('')).toBe(false);
  });
});
