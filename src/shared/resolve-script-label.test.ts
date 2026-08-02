import { describe, expect, it } from 'vitest';
import { resolveScriptFileName, resolveScriptLabel } from './resolve-script-label';

describe('resolveScriptLabel', () => {
  it('prefers the user-set label over everything else', () => {
    expect(
      resolveScriptLabel('uuid-1', { userLabel: 'My Script', reportLabel: 'declared-id', fileName: 'upload.js' }),
    ).toBe('My Script');
  });

  it('falls back to the manifest-reported id when no user label is set', () => {
    expect(resolveScriptLabel('uuid-1', { reportLabel: 'declared-id', fileName: 'upload.js' })).toBe('declared-id');
  });

  it('falls back to the upload filename when neither user label nor report id is known', () => {
    expect(resolveScriptLabel('uuid-1', { fileName: 'upload.js' })).toBe('upload.js');
  });

  it('falls back to the raw id as the last resort', () => {
    expect(resolveScriptLabel('uuid-1', {})).toBe('uuid-1');
  });
});

describe('resolveScriptFileName', () => {
  it('uses the captured upload filename when present', () => {
    expect(resolveScriptFileName('my-upload.js', 'ignored label')).toBe('my-upload.js');
  });

  it('slugifies the label when no filename was captured', () => {
    expect(resolveScriptFileName(undefined, 'My Cool Script')).toBe('my-cool-script.js');
  });
});
