import { describe, expect, it } from 'vitest';
import {
  buildFakeResponseInit,
  buildRewriteOverrides,
  endpointPatternToRegexSource,
  getAction,
  getMechanism,
  hasActiveMockConfig,
  matchMockConfig,
  validateMockConfig,
  type MockConfig,
} from './http-mock';

function config(overrides: Partial<MockConfig> = {}): MockConfig {
  return {
    id: 'rule-1',
    endpointPattern: '/api/users',
    method: 'GET',
    mechanism: 'main-world',
    action: 'fake-response',
    active: true,
    ...overrides,
  };
}

describe('getMechanism / getAction — back-compat for configs persisted before those fields existed', () => {
  it('defaults a config without `mechanism` to main-world and without `action` to fake-response', () => {
    const legacy = { id: 'x', endpointPattern: '/a', method: 'GET', active: true } as unknown as MockConfig;
    expect(getMechanism(legacy)).toBe('main-world');
    expect(getAction(legacy)).toBe('fake-response');
  });

  it('returns the stored value when present', () => {
    expect(getMechanism(config({ mechanism: 'dnr' }))).toBe('dnr');
    expect(getAction(config({ action: 'block', mechanism: 'dnr' }))).toBe('block');
  });
});

describe('endpointPatternToRegexSource', () => {
  it('turns * into a wildcard and escapes every other regex metacharacter', () => {
    expect(endpointPatternToRegexSource('/api/*/users')).toBe('/api/.*/users');
    expect(endpointPatternToRegexSource('/api/v1.0/users?id=1')).toBe('/api/v1\\.0/users\\?id=1');
    expect(endpointPatternToRegexSource('a+b(c)')).toBe('a\\+b\\(c\\)');
  });

  it('produces an unanchored source, preserving the original substring-match behavior', () => {
    const re = new RegExp(endpointPatternToRegexSource('/api/users'));
    expect(re.test('https://example.com/api/users?page=2')).toBe(true);
  });
});

describe('matchMockConfig', () => {
  it('matches on endpointPattern with * wildcards', () => {
    const configs = [config({ endpointPattern: '/api/*/users' })];
    expect(matchMockConfig(configs, 'https://x.test/api/v2/users', 'GET', 'main-world')?.id).toBe('rule-1');
    expect(matchMockConfig(configs, 'https://x.test/api/users', 'GET', 'main-world')).toBeUndefined();
  });

  it('never lets one mechanism answer another mechanism’s rule', () => {
    const configs = [config({ mechanism: 'debugger' })];
    expect(matchMockConfig(configs, 'https://x.test/api/users', 'GET', 'debugger')?.id).toBe('rule-1');
    expect(matchMockConfig(configs, 'https://x.test/api/users', 'GET', 'main-world')).toBeUndefined();
  });

  it('skips inactive configs', () => {
    const configs = [config({ active: false })];
    expect(matchMockConfig(configs, 'https://x.test/api/users', 'GET', 'main-world')).toBeUndefined();
  });

  it('matches method case-insensitively, and method ALL matches anything', () => {
    expect(matchMockConfig([config()], 'https://x.test/api/users', 'get', 'main-world')?.id).toBe('rule-1');
    expect(matchMockConfig([config()], 'https://x.test/api/users', 'POST', 'main-world')).toBeUndefined();
    const all = [config({ method: 'ALL' })];
    expect(matchMockConfig(all, 'https://x.test/api/users', 'DELETE', 'main-world')?.id).toBe('rule-1');
  });

  it('returns the FIRST matching config, so list order is the tie-breaker', () => {
    const configs = [config({ id: 'first' }), config({ id: 'second' })];
    expect(matchMockConfig(configs, 'https://x.test/api/users', 'GET', 'main-world')?.id).toBe('first');
  });

  it('checks requestMatchContains against the URL and, when supplied, the body', () => {
    const configs = [config({ method: 'POST', requestMatchContains: 'needle' })];
    // Body available (fetch path) — matches on the body.
    expect(matchMockConfig(configs, 'https://x.test/api/users', 'POST', 'main-world', '{"q":"needle"}')?.id).toBe('rule-1');
    // Body absent (XHR path evaluates at open() time, before a body exists) — URL alone must still work.
    expect(matchMockConfig(configs, 'https://x.test/api/users?q=needle', 'POST', 'main-world')?.id).toBe('rule-1');
    // Neither carries it.
    expect(matchMockConfig(configs, 'https://x.test/api/users', 'POST', 'main-world', '{"q":"other"}')).toBeUndefined();
  });

  it('ignores a non-string body when checking requestMatchContains', () => {
    const configs = [config({ requestMatchContains: 'needle' })];
    expect(matchMockConfig(configs, 'https://x.test/api/users', 'GET', 'main-world', { q: 'needle' })).toBeUndefined();
  });
});

describe('hasActiveMockConfig', () => {
  it('is true only when a config is both active and belongs to that mechanism', () => {
    const configs = [config({ mechanism: 'debugger', active: false }), config({ id: 'b', mechanism: 'dnr' })];
    expect(hasActiveMockConfig(configs, 'dnr')).toBe(true);
    expect(hasActiveMockConfig(configs, 'debugger')).toBe(false);
    expect(hasActiveMockConfig(configs, 'main-world')).toBe(false);
    expect(hasActiveMockConfig([], 'dnr')).toBe(false);
  });
});

describe('validateMockConfig — shape', () => {
  const base = {
    id: 'r1',
    endpointPattern: '/api/users',
    method: 'GET',
    mechanism: 'main-world',
    action: 'fake-response',
    fakeStatus: 500,
    active: true,
  };

  it('accepts a well-formed fake-response config', () => {
    const result = validateMockConfig({ ...base, fakeResponse: '{"error":"boom"}' });
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.config).toMatchObject({ id: 'r1', fakeStatus: 500, action: 'fake-response' });
  });

  it('rejects non-objects and missing/blank required fields', () => {
    expect(validateMockConfig(null)).toMatchObject({ valid: false });
    expect(validateMockConfig('nope')).toMatchObject({ valid: false });
    expect(validateMockConfig({ ...base, id: '' })).toMatchObject({ valid: false });
    expect(validateMockConfig({ ...base, endpointPattern: '' })).toMatchObject({ valid: false });
    expect(validateMockConfig({ ...base, method: 'FETCH' })).toMatchObject({ valid: false });
    expect(validateMockConfig({ ...base, mechanism: 'proxy' })).toMatchObject({ valid: false });
    expect(validateMockConfig({ ...base, action: 'redirect' })).toMatchObject({ valid: false });
    expect(validateMockConfig({ ...base, active: 'yes' })).toMatchObject({ valid: false });
  });

  it('drops fields belonging to the other action rather than carrying them through', () => {
    const result = validateMockConfig({ ...base, rewriteUrl: 'https://elsewhere.test' });
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.config.rewriteUrl).toBeUndefined();
  });

  it('requires an in-range fakeStatus for fake-response on every mechanism except dnr', () => {
    expect(validateMockConfig({ ...base, fakeStatus: undefined })).toMatchObject({ valid: false });
    expect(validateMockConfig({ ...base, fakeStatus: 99 })).toMatchObject({ valid: false });
    expect(validateMockConfig({ ...base, fakeStatus: 600 })).toMatchObject({ valid: false });
    // dnr fakes via a data: URL redirect, which has no status-code concept — optional there...
    expect(validateMockConfig({ ...base, mechanism: 'dnr', fakeStatus: undefined })).toMatchObject({ valid: true });
    // ...but still range-checked if given anyway.
    expect(validateMockConfig({ ...base, mechanism: 'dnr', fakeStatus: 999 })).toMatchObject({ valid: false });
  });

  it('validates the optional numeric/string fields', () => {
    expect(validateMockConfig({ ...base, delayMs: -1 })).toMatchObject({ valid: false });
    expect(validateMockConfig({ ...base, delayMs: 0 })).toMatchObject({ valid: true });
    expect(validateMockConfig({ ...base, hitCountLimit: 0 })).toMatchObject({ valid: false });
    expect(validateMockConfig({ ...base, hitCountLimit: 1 })).toMatchObject({ valid: true });
    expect(validateMockConfig({ ...base, responseHeaders: 42 })).toMatchObject({ valid: false });
    expect(validateMockConfig({ ...base, requestMatchContains: 42 })).toMatchObject({ valid: false });
  });

  it('carries matchCount through untouched (runtime bookkeeping, never a form field)', () => {
    const result = validateMockConfig({ ...base, matchCount: 7 });
    expect(result.valid && result.config.matchCount).toBe(7);
  });

  it('normalizes rewriteMethod to upper case and rejects unknown ones', () => {
    const ok = validateMockConfig({ ...base, action: 'rewrite-request', fakeStatus: undefined, rewriteMethod: 'post' });
    expect(ok.valid && ok.config.rewriteMethod).toBe('POST');
    // ALL is a MATCH-side value only; a rewrite has to name one concrete method.
    expect(
      validateMockConfig({ ...base, action: 'rewrite-request', fakeStatus: undefined, rewriteMethod: 'ALL' }),
    ).toMatchObject({ valid: false });
  });
});

describe('validateMockConfig — mechanism capability limits (reject, never silently ignore)', () => {
  const base = { id: 'r1', endpointPattern: '/api/users', method: 'GET', active: true };

  it('requires debugger or dnr for action "block" (main-world cannot fail a request at the network layer)', () => {
    expect(validateMockConfig({ ...base, mechanism: 'main-world', action: 'block' })).toMatchObject({ valid: false });
    expect(validateMockConfig({ ...base, mechanism: 'debugger', action: 'block' })).toMatchObject({ valid: true });
    expect(validateMockConfig({ ...base, mechanism: 'dnr', action: 'block' })).toMatchObject({ valid: true });
  });

  it('refuses dnr rules that need something declarativeNetRequest structurally cannot do', () => {
    const dnrRewrite = { ...base, mechanism: 'dnr', action: 'rewrite-request' };
    expect(validateMockConfig({ ...dnrRewrite, rewriteMethod: 'POST' })).toMatchObject({ valid: false });
    expect(validateMockConfig({ ...dnrRewrite, rewriteBody: '{}' })).toMatchObject({ valid: false });
    expect(validateMockConfig({ ...dnrRewrite, rewriteBodyFile: '{"blobRef":"b1"}' })).toMatchObject({ valid: false });
    // DNR conditions only ever see the URL, never the body.
    expect(
      validateMockConfig({ ...base, mechanism: 'dnr', action: 'block', requestMatchContains: 'x' }),
    ).toMatchObject({ valid: false });
    // The same rule is fine on a mechanism that has a live per-request callback.
    expect(
      validateMockConfig({ ...base, mechanism: 'debugger', action: 'rewrite-request', rewriteBody: '{}' }),
    ).toMatchObject({ valid: true });
  });
});

describe('validateMockConfig — file field unpacking', () => {
  const base = {
    id: 'r1',
    endpointPattern: '/api/users',
    method: 'GET',
    mechanism: 'debugger',
    action: 'fake-response',
    fakeStatus: 200,
    active: true,
  };
  const inline = { mimeType: 'image/png', fileName: 'a.png', base64: 'AAAA' };

  it('splits the form’s combined JSON into blobRef / name / inline fields', () => {
    const result = validateMockConfig({
      ...base,
      fakeResponseFile: JSON.stringify({ blobRef: 'blob-1', fileName: 'a.png', inline }),
    });
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.config.fakeResponseFile).toBe('blob-1');
    expect(result.config.fakeResponseFileName).toBe('a.png');
    expect(result.config.fakeResponseFileInline).toEqual(inline);
  });

  it('applies the same unpacking to a rewrite body file', () => {
    const result = validateMockConfig({
      ...base,
      action: 'rewrite-request',
      fakeStatus: undefined,
      rewriteBodyFile: JSON.stringify({ blobRef: 'blob-2', fileName: 'body.bin', inline }),
    });
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.config.rewriteBodyFile).toBe('blob-2');
    expect(result.config.rewriteBodyFileName).toBe('body.bin');
    expect(result.config.rewriteBodyFileInline).toEqual(inline);
  });

  it('degrades a malformed or oversized half to "absent" instead of rejecting the whole config', () => {
    const malformed = validateMockConfig({ ...base, fakeResponseFile: 'not json' });
    expect(malformed.valid).toBe(true);
    if (!malformed.valid) return;
    expect(malformed.config.fakeResponseFile).toBeUndefined();
    expect(malformed.config.fakeResponseFileInline).toBeUndefined();

    // Over MAX_INLINE_FILE_BASE64_LENGTH (3MB): the blobRef half is kept, only the inline half drops
    // — the debugger mechanism can still serve this file from IndexedDB.
    const oversized = validateMockConfig({
      ...base,
      fakeResponseFile: JSON.stringify({
        blobRef: 'blob-1',
        inline: { ...inline, base64: 'A'.repeat(3 * 1024 * 1024 + 1) },
      }),
    });
    expect(oversized.valid).toBe(true);
    if (!oversized.valid) return;
    expect(oversized.config.fakeResponseFile).toBe('blob-1');
    expect(oversized.config.fakeResponseFileInline).toBeUndefined();
  });

  it('rejects a file field that is present but not a non-empty string', () => {
    expect(validateMockConfig({ ...base, fakeResponseFile: '' })).toMatchObject({ valid: false });
    expect(validateMockConfig({ ...base, fakeResponseFile: 123 })).toMatchObject({ valid: false });
  });
});

describe('buildFakeResponseInit', () => {
  it('renders status, a Synapse-identifying statusText, and string bodies verbatim', () => {
    const init = buildFakeResponseInit(config({ fakeStatus: 503, fakeResponse: 'plain text' }));
    expect(init).toMatchObject({ status: 503, bodyText: 'plain text' });
    expect(init.statusText).toContain('rule-1');
  });

  it('JSON-stringifies a non-string body and falls back to 200 / empty string', () => {
    expect(buildFakeResponseInit(config({ fakeResponse: { a: 1 } })).bodyText).toBe('{"a":1}');
    const bare = buildFakeResponseInit(config());
    expect(bare.status).toBe(200);
    expect(bare.bodyText).toBe('""');
  });

  it('parses responseHeaders JSON, and omits headers entirely when it is malformed', () => {
    expect(buildFakeResponseInit(config({ responseHeaders: '{"X-Foo":"bar"}' })).headers).toEqual({ 'X-Foo': 'bar' });
    // A typo in this one optional field must not take down the rest of the rule.
    expect(buildFakeResponseInit(config({ responseHeaders: '{oops' })).headers).toBeUndefined();
    expect(buildFakeResponseInit(config({ responseHeaders: '"a string"' })).headers).toBeUndefined();
  });
});

describe('buildRewriteOverrides', () => {
  const rewrite = (overrides: Partial<MockConfig>) => buildRewriteOverrides(config({ action: 'rewrite-request', ...overrides }));

  it('includes only the fields actually set (an omitted one means "keep the original")', () => {
    expect(rewrite({})).toEqual({});
    expect(rewrite({ rewriteUrl: 'https://elsewhere.test', rewriteMethod: 'POST' })).toEqual({
      url: 'https://elsewhere.test',
      method: 'POST',
    });
  });

  it('parses rewriteHeaders JSON and drops it when malformed', () => {
    expect(rewrite({ rewriteHeaders: '{"X-Foo":"bar"}' }).headers).toEqual({ 'X-Foo': 'bar' });
    expect(rewrite({ rewriteHeaders: 'nope' }).headers).toBeUndefined();
  });

  it('marks a text body utf8 by leaving bodyEncoding unset (its documented default)', () => {
    const overrides = rewrite({ rewriteBody: '{"a":1}' });
    expect(overrides.body).toBe('{"a":1}');
    expect(overrides.bodyEncoding).toBeUndefined();
  });

  it('lets an inline file beat typed text AND tags it base64 — the §2.6.1 binary-corruption fix', () => {
    // Without bodyEncoding, both the main-world fetch/XHR patch and the debugger CDP postData path
    // re-encoded these base64 bytes as if they were text, corrupting every binary upload.
    const overrides = rewrite({
      rewriteBody: 'typed text that must lose',
      rewriteBodyFileInline: { mimeType: 'application/octet-stream', fileName: 'x.bin', base64: 'AAECAw==' },
    });
    expect(overrides.body).toBe('AAECAw==');
    expect(overrides.bodyEncoding).toBe('base64');
  });

  it('leaves a blobRef-only file to the caller (resolving it needs IndexedDB, which this layer lacks)', () => {
    const overrides = rewrite({ rewriteBodyFile: 'blob-1', rewriteBody: 'fallback text' });
    // No inline half here, so the Global SDK can only report the text — the background composition
    // root overrides this after its own IndexedDB read.
    expect(overrides.body).toBe('fallback text');
    expect(overrides.bodyEncoding).toBeUndefined();
  });
});
