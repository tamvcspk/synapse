import { describe, expect, it } from 'vitest';
import {
  ALL_SCOPES,
  API_METHODS,
  SCOPE_CATALOG,
  consentLineFor,
  grantsAllow,
  isMatchExemptMethod,
  isSynapseScope,
  normalizeScopeGrants,
  resourceUrlForCall,
  scopeForApiMethod,
  ungrantedScopes,
} from './scopes';

describe('scope catalog invariants (docs/ROADMAP.md §11.3, Track B2e)', () => {
  it('gives every scope either requiresMatch or an unboundedReason explaining why not (Track B2e)', () => {
    for (const scope of ALL_SCOPES) {
      const def = SCOPE_CATALOG[scope];
      if (def.requiresMatch) continue;
      expect(def.unboundedReason, `scope "${scope}" has neither requiresMatch nor unboundedReason`).toBeTruthy();
      expect(def.unboundedReason!.length).toBeGreaterThan(0);
    }
  });

  it('gives every scope a consent line and a description (constraint E — the doc generator’s source)', () => {
    for (const scope of ALL_SCOPES) {
      expect(SCOPE_CATALOG[scope].consentLine.length).toBeGreaterThan(0);
      expect(SCOPE_CATALOG[scope].description.length).toBeGreaterThan(0);
    }
  });

  it('has no scope named after a transport — `bus` is plumbing, never a permission', () => {
    expect(ALL_SCOPES).not.toContain('bus');
    expect(isSynapseScope('bus')).toBe(false);
  });

  it('gives every catalogued API method a scope that exists — except lib.*, which never has one', () => {
    for (const method of API_METHODS) {
      if (method.namespace === 'lib') {
        expect(method.scope).toBeUndefined();
      } else {
        expect(isSynapseScope(method.scope)).toBe(true);
      }
      expect(method.description.length).toBeGreaterThan(0);
    }
  });

  it('classifies page.dom as Disclosed — refusing it protects nobody in the on-page container', () => {
    expect(SCOPE_CATALOG['page.dom'].enforcement).toBe('disclosed');
    expect(SCOPE_CATALOG['storage.rw'].enforcement).toBe('enforced');
  });
});

describe('scopeForApiMethod — fail-closed routing', () => {
  it('resolves catalogued methods', () => {
    expect(scopeForApiMethod('storage', 'get')).toBe('storage.rw');
    expect(scopeForApiMethod('storage', 'keys')).toBe('storage.rw');
  });

  it('returns undefined for anything not catalogued, including prototype members', () => {
    expect(scopeForApiMethod('storage', 'clear')).toBeUndefined();
    expect(scopeForApiMethod('storage', 'constructor')).toBeUndefined();
    expect(scopeForApiMethod('storage', '__proto__')).toBeUndefined();
    expect(scopeForApiMethod('cache', 'get')).toBeUndefined(); // retired Capability service
  });
});

describe('normalizeScopeGrants', () => {
  it('accepts the string shorthand and the object form', () => {
    expect(normalizeScopeGrants(['storage.rw'])).toEqual({ valid: true, grants: [{ scope: 'storage.rw' }] });
    expect(normalizeScopeGrants([{ scope: 'page.dom', match: ['*://example.com/*'] }])).toEqual({
      valid: true,
      grants: [{ scope: 'page.dom', match: ['*://example.com/*'] }],
    });
  });

  it('treats an absent declaration as no scopes', () => {
    expect(normalizeScopeGrants(undefined)).toEqual({ valid: true, grants: [] });
  });

  it('REJECTS an unknown scope rather than dropping it — a permission that quietly resolves to nothing is the failure this model replaces', () => {
    expect(normalizeScopeGrants(['net'])).toEqual({ valid: false, reason: 'unknown scope "net"' });
    expect(normalizeScopeGrants(['dom'])).toMatchObject({ valid: false });
    expect(normalizeScopeGrants(['bus'])).toMatchObject({ valid: false });
    expect(normalizeScopeGrants('storage.rw')).toMatchObject({ valid: false });
  });

  it('rejects a malformed match list', () => {
    expect(normalizeScopeGrants([{ scope: 'page.dom', match: 'example.com' }])).toMatchObject({ valid: false });
    expect(normalizeScopeGrants([{ scope: 'page.dom', match: [1] }])).toMatchObject({ valid: false });
  });

  it('rejects a match entry that is not a well-formed match pattern', () => {
    expect(normalizeScopeGrants([{ scope: 'net.request', match: ['example.com'] }])).toEqual({
      valid: false,
      reason: 'scope "net.request": "example.com" is not a valid match pattern',
    });
  });

  it('requires net.request to carry a non-empty match list', () => {
    expect(normalizeScopeGrants(['net.request'])).toEqual({
      valid: false,
      reason: 'scope "net.request" requires a non-empty match list',
    });
  });

  it('accepts a well-formed net.request grant', () => {
    expect(normalizeScopeGrants([{ scope: 'net.request', match: ['*://api.example.com/*'] }])).toEqual({
      valid: true,
      grants: [{ scope: 'net.request', match: ['*://api.example.com/*'] }],
    });
  });

  it('accepts files.save with no match list — it has no resource dimension', () => {
    expect(normalizeScopeGrants(['files.save'])).toEqual({ valid: true, grants: [{ scope: 'files.save' }] });
  });

  it('omits `match` entirely when absent, so persisted grants compare by value', () => {
    const result = normalizeScopeGrants(['storage.rw']);
    expect(result.valid && 'match' in result.grants[0]!).toBe(false);
  });
});

describe('grantsAllow — the single enforcement funnel', () => {
  it('allows only what was granted', () => {
    expect(grantsAllow([{ scope: 'storage.rw' }], 'storage.rw')).toBe(true);
    expect(grantsAllow([{ scope: 'page.dom' }], 'storage.rw')).toBe(false);
    expect(grantsAllow([], 'storage.rw')).toBe(false);
  });

  describe('resource dimension (requiresMatch scopes)', () => {
    const grant = { scope: 'net.request' as const, match: ['*://api.example.com/*'] };

    it('allows a resource URL covered by the grant\'s match patterns', () => {
      expect(grantsAllow([grant], 'net.request', 'https://api.example.com/v1/x')).toBe(true);
    });

    it('denies a resource URL outside every granted match pattern', () => {
      expect(grantsAllow([grant], 'net.request', 'https://evil.example/x')).toBe(false);
    });

    it('denies (fails closed) when no resourceUrl could be determined, even with the scope granted', () => {
      expect(grantsAllow([grant], 'net.request', undefined)).toBe(false);
    });

    it('denies when the scope itself was never granted, regardless of resourceUrl', () => {
      expect(grantsAllow([], 'net.request', 'https://api.example.com/v1/x')).toBe(false);
    });
  });

  it('ignores resourceUrl entirely for a scope with no resource dimension (files.save)', () => {
    expect(grantsAllow([{ scope: 'files.save' }], 'files.save')).toBe(true);
    expect(grantsAllow([{ scope: 'files.save' }], 'files.save', 'https://irrelevant.example/')).toBe(true);
    expect(grantsAllow([], 'files.save')).toBe(false);
  });
});

describe('resourceUrlForCall', () => {
  it('extracts the url from net.request\'s options argument', () => {
    expect(resourceUrlForCall('net', 'request', [{ url: 'https://api.example.com/x' }])).toBe(
      'https://api.example.com/x',
    );
  });

  it('returns undefined for a method with no resourceUrl extractor', () => {
    expect(resourceUrlForCall('storage', 'get', ['key'])).toBeUndefined();
    expect(resourceUrlForCall('files', 'save', [{ filename: 'x.txt', content: 'hi' }])).toBeUndefined();
  });

  it('returns undefined for an unknown method rather than throwing', () => {
    expect(resourceUrlForCall('net', 'nope', [{ url: 'https://x.test/' }])).toBeUndefined();
  });

  it('returns undefined when the argument is malformed (missing/non-string url)', () => {
    expect(resourceUrlForCall('net', 'request', [{}])).toBeUndefined();
    expect(resourceUrlForCall('net', 'request', [{ url: 123 }])).toBeUndefined();
    expect(resourceUrlForCall('net', 'request', [])).toBeUndefined();
  });
});

describe('page.eval — resource comes from context, not args', () => {
  it('resolves scopeForApiMethod for page.eval', () => {
    expect(scopeForApiMethod('page', 'eval')).toBe('page.eval');
  });

  it('ignores args entirely and pulls the resource url from context.tabUrl', () => {
    expect(resourceUrlForCall('page', 'eval', ['alert(1)'], { tabUrl: 'https://real-tab.example/' })).toBe(
      'https://real-tab.example/',
    );
  });

  it('a caller-supplied url inside args is never consulted — only context matters', () => {
    expect(resourceUrlForCall('page', 'eval', [{ url: 'https://attacker.example/' }])).toBeUndefined();
  });

  it('returns undefined (and so denies, fail-closed) when the call has no known tab context', () => {
    expect(resourceUrlForCall('page', 'eval', ['alert(1)'])).toBeUndefined();
    expect(resourceUrlForCall('page', 'eval', ['alert(1)'], {})).toBeUndefined();
  });

  it('is enforced and requiresMatch, the highest-privilege scope in the catalog', () => {
    expect(SCOPE_CATALOG['page.eval'].enforcement).toBe('enforced');
    expect(SCOPE_CATALOG['page.eval'].requiresMatch).toBe(true);
  });

  it('grantsAllow checks the real tab url the same way it checks any other requiresMatch resource', () => {
    const grant = { scope: 'page.eval' as const, match: ['*://real-tab.example/*'] };
    const url = resourceUrlForCall('page', 'eval', [], { tabUrl: 'https://real-tab.example/' });
    expect(grantsAllow([grant], 'page.eval', url)).toBe(true);
    expect(grantsAllow([grant], 'page.eval', 'https://attacker.example/')).toBe(false);
    expect(grantsAllow([grant], 'page.eval', undefined)).toBe(false);
  });
});

describe('ai.ask — reuses net.request\'s scope rather than adding an 11th (docs/ROADMAP.md §11.6)', () => {
  it('resolves scopeForApiMethod to net.request, not a scope of its own', () => {
    expect(scopeForApiMethod('ai', 'ask')).toBe('net.request');
  });

  it('does not add to the scope catalog', () => {
    expect(isSynapseScope('ai.ask')).toBe(false);
    expect(ALL_SCOPES).not.toContain('ai.ask');
  });

  it('derives the resourceUrl from baseUrl when given', () => {
    expect(
      resourceUrlForCall('ai', 'ask', [{ provider: 'openai', baseUrl: 'https://my-proxy.example/v1/chat' }]),
    ).toBe('https://my-proxy.example/v1/chat');
  });

  it('falls back to each provider\'s default endpoint when baseUrl is omitted', () => {
    expect(resourceUrlForCall('ai', 'ask', [{ provider: 'openai' }])).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
    expect(resourceUrlForCall('ai', 'ask', [{ provider: 'ollama' }])).toBe('http://localhost:11434/api/chat');
  });

  it('returns undefined for an unrecognized/missing provider — fail-closed, not a guess', () => {
    expect(resourceUrlForCall('ai', 'ask', [{ provider: 'anthropic' }])).toBeUndefined();
    expect(resourceUrlForCall('ai', 'ask', [{}])).toBeUndefined();
    expect(resourceUrlForCall('ai', 'ask', [])).toBeUndefined();
  });

  it('a net.request grant covering the provider host is what makes ai.ask callable via grantsAllow', () => {
    const grant = { scope: 'net.request' as const, match: ['https://api.openai.com/*'] };
    const url = resourceUrlForCall('ai', 'ask', [{ provider: 'openai' }]);
    expect(grantsAllow([grant], 'net.request', url)).toBe(true);
    expect(grantsAllow([grant], 'net.request', 'http://localhost:11434/api/chat')).toBe(false);
  });
});

describe('net.mock.debugger — docs/ROADMAP.md Track B2b, the extra grant for the one debugger-only combo', () => {
  it('is enforced, requiresMatch, and its consent line names the "being debugged" banner explicitly', () => {
    expect(SCOPE_CATALOG['net.mock.debugger'].enforcement).toBe('enforced');
    expect(SCOPE_CATALOG['net.mock.debugger'].requiresMatch).toBe(true);
    expect(SCOPE_CATALOG['net.mock.debugger'].consentLine.toLowerCase()).toContain('debug');
  });

  it('is a real, addressable scope name', () => {
    expect(isSynapseScope('net.mock.debugger')).toBe(true);
    expect(ALL_SCOPES).toContain('net.mock.debugger');
  });
});

describe('net.mock — dotted method names + matchExempt', () => {
  it('resolves scopeForApiMethod/resourceUrlForCall for a dotted method name (mock.add)', () => {
    expect(scopeForApiMethod('net', 'mock.add')).toBe('net.mock');
    expect(resourceUrlForCall('net', 'mock.add', [{ endpointPattern: 'https://api.example.com/*' }])).toBe(
      'https://api.example.com/*',
    );
  });

  it('exempts mock.remove/mock.list from the resource check — they act on something already checked at mock.add time', () => {
    expect(isMatchExemptMethod('net', 'mock.remove')).toBe(true);
    expect(isMatchExemptMethod('net', 'mock.list')).toBe(true);
  });

  it('does NOT exempt mock.add — it is the one call that reaches a new resource', () => {
    expect(isMatchExemptMethod('net', 'mock.add')).toBe(false);
  });

  it('is false (not exempt) for every non-net.mock method too, including the unknown-method case', () => {
    expect(isMatchExemptMethod('net', 'request')).toBe(false);
    expect(isMatchExemptMethod('storage', 'get')).toBe(false);
    expect(isMatchExemptMethod('net', 'nope')).toBe(false);
  });

  it('a grant of net.mock with match still enforces the resource dimension for mock.add via grantsAllow', () => {
    const grant = { scope: 'net.mock' as const, match: ['https://api.example.com/*'] };
    expect(grantsAllow([grant], 'net.mock', 'https://api.example.com/users')).toBe(true);
    expect(grantsAllow([grant], 'net.mock', 'https://evil.example/x')).toBe(false);
    expect(grantsAllow([grant], 'net.mock', undefined)).toBe(false);
  });
});

describe('consentLineFor', () => {
  it('renders the catalog line', () => {
    expect(consentLineFor({ scope: 'storage.rw' })).toBe("Store this script's own data");
  });

  it('substitutes {domains} from the grant’s match patterns when a line carries one', () => {
    const line = consentLineFor({ scope: 'net.request', match: ['*://a.test/*', '*://b.test/*'] });
    expect(line).toBe("Make network requests, under this extension's identity, to *://a.test/*, *://b.test/*");
  });

  it('is a no-op, not a crash, for a scope whose line has no {domains} placeholder', () => {
    const line = consentLineFor({ scope: 'page.fetch', match: ['*://a.test/*'] });
    expect(line).not.toContain('{domains}');
  });
});

describe('ungrantedScopes — what a consent prompt must ask about', () => {
  it('returns the delta only', () => {
    expect(ungrantedScopes([{ scope: 'storage.rw' }, { scope: 'page.dom' }], [{ scope: 'page.dom' }])).toEqual([
      { scope: 'storage.rw' },
    ]);
  });

  it('re-prompts when a match list widens, not just when a scope name is new', () => {
    const requested = [{ scope: 'page.fetch' as const, match: ['*://a.test/*', '*://b.test/*'] }];
    const granted = [{ scope: 'page.fetch' as const, match: ['*://a.test/*'] }];
    expect(ungrantedScopes(requested, granted)).toEqual(requested);
  });
});
