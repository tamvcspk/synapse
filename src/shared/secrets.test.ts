import { describe, expect, it } from 'vitest';
import { validateSecretRecord, type SecretRecord } from './secrets';

function makeRecord(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'id-1',
    name: 'my-openai-key',
    value: 'sk-test',
    allowedHost: 'https://api.openai.com/*',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('validateSecretRecord', () => {
  it('accepts a well-formed record with no other secrets to conflict with', () => {
    const result = validateSecretRecord(makeRecord(), []);
    expect(result.valid).toBe(true);
  });

  it('rejects a non-object candidate', () => {
    expect(validateSecretRecord(null, []).valid).toBe(false);
    expect(validateSecretRecord('nope', []).valid).toBe(false);
  });

  it('rejects a missing/empty id', () => {
    const result = validateSecretRecord(makeRecord({ id: '' }), []);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/id/);
  });

  it('rejects a missing/blank name', () => {
    expect(validateSecretRecord(makeRecord({ name: '' }), []).valid).toBe(false);
    expect(validateSecretRecord(makeRecord({ name: '   ' }), []).valid).toBe(false);
  });

  it('rejects a name already used by another secret — names must be unique (a script resolves by name alone)', () => {
    const others: SecretRecord[] = [
      { id: 'other', name: 'my-openai-key', value: 'x', allowedHost: 'https://x.example/*', createdAt: 0, updatedAt: 0 },
    ];
    const result = validateSecretRecord(makeRecord(), others);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/already exists/);
  });

  it('does not conflict with itself when editing (same name, excluded from `others` by the caller)', () => {
    // Mirrors what secrets.background.ts's run() actually passes: `others` already excludes the
    // record being edited, so re-saving it unchanged must not trip the uniqueness check.
    const result = validateSecretRecord(makeRecord(), []);
    expect(result.valid).toBe(true);
  });

  it('rejects a missing/empty value', () => {
    expect(validateSecretRecord(makeRecord({ value: '' }), []).valid).toBe(false);
  });

  it('rejects an allowedHost that is not a valid match pattern', () => {
    const result = validateSecretRecord(makeRecord({ allowedHost: 'not-a-pattern' }), []);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/match pattern/);
  });

  it('rejects missing timestamps', () => {
    expect(validateSecretRecord(makeRecord({ createdAt: undefined }), []).valid).toBe(false);
    expect(validateSecretRecord(makeRecord({ updatedAt: undefined }), []).valid).toBe(false);
  });
});
