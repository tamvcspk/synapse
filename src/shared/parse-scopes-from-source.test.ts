import { describe, expect, it } from 'vitest';
import { parseScopesFromSource } from './parse-scopes-from-source';

describe('parseScopesFromSource', () => {
  it('returns an empty array when there is no scopes declaration', () => {
    expect(parseScopesFromSource('__synapseModule = { id: "x", async run() {} };')).toEqual([]);
  });

  it('parses bare string scopes', () => {
    expect(parseScopesFromSource(`__synapseModule = { id: 'x', scopes: ['storage.rw', 'page.dom'] };`)).toEqual([
      'storage.rw',
      'page.dom',
    ]);
  });

  it('parses an object-form scope with a match array', () => {
    expect(
      parseScopesFromSource(
        `__synapseModule = { id: 'x', scopes: [{ scope: 'net.mock', match: ['https://api.example.com/*'] }] };`,
      ),
    ).toEqual([{ scope: 'net.mock', match: ['https://api.example.com/*'] }]);
  });

  it('parses an object-form scope with no match', () => {
    expect(parseScopesFromSource(`scopes: [{ scope: 'media' }],`)).toEqual([{ scope: 'media' }]);
  });

  it('parses a mix of bare strings and object-form scopes', () => {
    expect(
      parseScopesFromSource(`scopes: ['storage.rw', { scope: 'net.request', match: ['https://a.example/*', 'https://b.example/*'] }],`),
    ).toEqual([
      'storage.rw',
      { scope: 'net.request', match: ['https://a.example/*', 'https://b.example/*'] },
    ]);
  });

  it('does not split a match array entry containing a comma', () => {
    expect(parseScopesFromSource(`scopes: [{ scope: 'net.request', match: ['https://example.com/*'] }, 'storage.rw'],`)).toEqual([
      { scope: 'net.request', match: ['https://example.com/*'] },
      'storage.rw',
    ]);
  });

  it('skips an entry it cannot parse rather than throwing', () => {
    expect(parseScopesFromSource(`scopes: [computedScope(), 'storage.rw'],`)).toEqual(['storage.rw']);
  });
});
