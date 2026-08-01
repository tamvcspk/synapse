import { describe, expect, it } from 'vitest';
import {
  ALL_SCOPES,
  API_METHODS,
  SCOPE_CATALOG,
  consentLineFor,
  grantsAllow,
  isSynapseScope,
  normalizeScopeGrants,
  scopeForApiMethod,
  ungrantedScopes,
} from './scopes';

describe('scope catalog invariants (docs/ROADMAP.md §11.3)', () => {
  it('caps the catalog at ~10 scopes — past that users click Allow on everything', () => {
    expect(ALL_SCOPES.length).toBeLessThanOrEqual(10);
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

  it('gives every catalogued API method a scope that exists', () => {
    for (const method of API_METHODS) {
      expect(isSynapseScope(method.scope)).toBe(true);
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
});

describe('consentLineFor', () => {
  it('renders the catalog line', () => {
    expect(consentLineFor({ scope: 'storage.rw' })).toBe("Store this script's own data");
  });

  it('substitutes {domains} from the grant’s match patterns when a line carries one', () => {
    const line = consentLineFor({ scope: 'page.fetch', match: ['*://a.test/*', '*://b.test/*'] });
    // No current scope's line contains {domains}; the substitution must still be a no-op, not a crash.
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
