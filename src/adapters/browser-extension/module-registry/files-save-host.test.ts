import { describe, expect, it } from 'vitest';
import type { DownloadsBackend } from './files-save-host';
import { performFilesSave } from './files-save-host';

/**
 * `downloads` is injected (same pattern as `script-storage.test.ts`'s `ScriptStorageBackend`), so
 * this file exercises the real encoding/validation logic without needing `chrome.downloads` or a
 * `Blob` global in `environment: 'node'`.
 */
function fakeDownloads(): DownloadsBackend & { calls: { url: string; filename?: string; saveAs?: boolean }[] } {
  const calls: { url: string; filename?: string; saveAs?: boolean }[] = [];
  return {
    calls,
    async download(options) {
      calls.push(options);
      return calls.length; // fake incrementing downloadId
    },
  };
}

describe('performFilesSave', () => {
  it('rejects a missing/empty filename before ever calling downloads.download', async () => {
    const downloads = fakeDownloads();
    await expect(performFilesSave({ filename: '', content: 'x' }, downloads)).rejects.toThrow(/"filename" is required/);
    expect(downloads.calls).toHaveLength(0);
  });

  it.each([
    '/etc/passwd',
    'C:\\Windows\\system32',
    '../../etc/passwd',
    'a/../../b',
    '..',
  ])('rejects a filename escaping the Downloads folder: %s', async (filename) => {
    const downloads = fakeDownloads();
    await expect(performFilesSave({ filename, content: 'x' }, downloads)).rejects.toThrow(/relative path/);
    expect(downloads.calls).toHaveLength(0);
  });

  it('accepts a relative subfolder path', async () => {
    const downloads = fakeDownloads();
    await performFilesSave({ filename: 'exports/report.txt', content: 'hi' }, downloads);
    expect(downloads.calls[0]?.filename).toBe('exports/report.txt');
  });

  it('encodes utf8 content (the default) as a data: URL with the text mime type', async () => {
    const downloads = fakeDownloads();
    await performFilesSave({ filename: 'x.txt', content: 'hello' }, downloads);

    const url = downloads.calls[0]!.url;
    expect(url.startsWith('data:text/plain;charset=utf-8;base64,')).toBe(true);
    const base64 = url.split(',')[1]!;
    expect(Buffer.from(base64, 'base64').toString('utf8')).toBe('hello');
  });

  it('encodes non-ASCII utf8 content correctly (not just Latin1)', async () => {
    const downloads = fakeDownloads();
    await performFilesSave({ filename: 'x.txt', content: 'xin chào 🎉' }, downloads);

    const base64 = downloads.calls[0]!.url.split(',')[1]!;
    expect(Buffer.from(base64, 'base64').toString('utf8')).toBe('xin chào 🎉');
  });

  it('passes base64 content straight through without a decode/re-encode round trip', async () => {
    const downloads = fakeDownloads();
    const original = Buffer.from([0, 1, 2, 255]).toString('base64');
    await performFilesSave({ filename: 'x.bin', content: original, contentEncoding: 'base64' }, downloads);

    const url = downloads.calls[0]!.url;
    expect(url.startsWith('data:application/octet-stream;base64,')).toBe(true);
    expect(url.split(',')[1]).toBe(original);
  });

  it('rejects malformed base64 content', async () => {
    const downloads = fakeDownloads();
    await expect(
      performFilesSave({ filename: 'x.bin', content: 'not base64 !!!', contentEncoding: 'base64' }, downloads),
    ).rejects.toThrow(/not valid base64/);
  });

  it('honors an explicit mimeType override', async () => {
    const downloads = fakeDownloads();
    await performFilesSave({ filename: 'x.json', content: '{}', mimeType: 'application/json' }, downloads);
    expect(downloads.calls[0]!.url.startsWith('data:application/json;base64,')).toBe(true);
  });

  it('defaults saveAs to false, and forwards true when requested', async () => {
    const downloads = fakeDownloads();
    await performFilesSave({ filename: 'a.txt', content: 'x' }, downloads);
    expect(downloads.calls[0]!.saveAs).toBe(false);

    await performFilesSave({ filename: 'b.txt', content: 'x', saveAs: true }, downloads);
    expect(downloads.calls[1]!.saveAs).toBe(true);
  });

  it('rejects content exceeding the size cap before calling downloads.download', async () => {
    const downloads = fakeDownloads();
    const huge = 'x'.repeat(26 * 1024 * 1024);
    await expect(performFilesSave({ filename: 'big.txt', content: huge }, downloads)).rejects.toThrow(/exceeds the/);
    expect(downloads.calls).toHaveLength(0);
  });

  it('resolves with the downloadId the backend returned', async () => {
    const downloads = fakeDownloads();
    const result = await performFilesSave({ filename: 'x.txt', content: 'hi' }, downloads);
    expect(result).toEqual({ downloadId: 1 });
  });
});
