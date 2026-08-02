import { bytesToBase64 } from '../utils/blob-store';
import type { SynapseFilesSaveOptions, SynapseFilesSaveResult } from '../../../kernel/synapse-api';

/**
 * Backs `synapseApi.files.save` (docs/api-inventory.md §6, item 2 — `GM_download`'s delta). Ships a
 * `data:` URL to `chrome.downloads.download` rather than the `Blob` + `URL.createObjectURL` +
 * background-relay dance `features/media/download/output.offscreen.ts` needs — that dance exists
 * ONLY because an Offscreen Document has no `chrome.downloads` and a blob: URL only resolves in the
 * document that created it (docs/LESSONS.md), so the blob has to be built in one context and the
 * download triggered from another. This function already runs in the one context with both
 * (`rpc-handler.ts`'s background service worker), so there is no second context to hand a URL to —
 * a `data:` URL sidesteps the whole blob-lifetime question (no `revokeObjectURL` timing to guess at)
 * and is simpler for it.
 *
 * `downloads` is injected (default: the real `chrome.downloads`) so the encoding/validation logic
 * here is unit-testable in `environment: 'node'`, without a `chrome.*` or `Blob` global — same
 * pattern `script-storage.ts`'s `ScriptStorageBackend` uses for the same reason.
 */

/** Lower than `net-request-host.ts`'s 25MB: `bytesToBase64` (`blob-store.ts`) is a byte-by-byte
 * loop, and unlike `net.request` (where base64 is opt-in, only for `responseType: 'arraybuffer'`),
 * `files.save`'s DEFAULT `'utf8'` encoding goes through it on every call — a 25MB text file measured
 * multiple seconds here, which would block the single-threaded service worker for that long on every
 * other message. 10MB matches this codebase's existing per-item cap for a comparable "one file
 * through a synchronous encode" case (fetch-images, ~10MB/image). */
const MAX_SAVE_FILE_BYTES = 10 * 1024 * 1024;

export interface DownloadsBackend {
  download(options: { url: string; filename?: string; saveAs?: boolean }): Promise<number>;
}

const realDownloadsBackend: DownloadsBackend = {
  download: (options) => chrome.downloads.download(options),
};

function assertSafeRelativeFilename(filename: unknown): asserts filename is string {
  if (typeof filename !== 'string' || filename === '') {
    throw new Error('files.save: "filename" is required');
  }
  if (filename.startsWith('/') || /^[a-zA-Z]:/.test(filename) || /(^|[\\/])\.\.([\\/]|$)/.test(filename)) {
    throw new Error(
      'files.save: "filename" must be a relative path inside the Downloads folder — no leading "/", ' +
        'no drive letter, no ".." segment',
    );
  }
}

/** Byte length of `options.content`, computed WITHOUT the slow path: `atob`/`TextEncoder.encode`
 * are native calls, unlike `blob-store.ts`'s `bytesToBase64`/`base64ToBytes`, which are JS
 * byte-by-byte loops. Checking the cap against this — before calling either of those — is what
 * makes the cap actually bound the work done, rather than the content being fully (slowly) encoded
 * first and only THEN rejected for being too big to have bothered. */
function contentByteLength(options: SynapseFilesSaveOptions): number {
  if (typeof options.content !== 'string') {
    throw new Error('files.save: "content" is required');
  }
  if (options.contentEncoding === 'base64') {
    try {
      return atob(options.content).length;
    } catch {
      throw new Error('files.save: "content" is not valid base64');
    }
  }
  return new TextEncoder().encode(options.content).length;
}

/** The base64 payload for the `data:` URL. For `contentEncoding: 'base64'` this is `options.content`
 * itself — passed straight through, deliberately never decoded to bytes and re-encoded (that
 * round trip is exactly the slow loop `contentByteLength` above avoids; the string is already in
 * the shape the `data:` URL needs). Only `'utf8'` content needs an actual encode. */
function encodedPayload(options: SynapseFilesSaveOptions): string {
  if (options.contentEncoding === 'base64') return options.content;
  return bytesToBase64(new TextEncoder().encode(options.content).buffer);
}

function defaultMimeType(options: SynapseFilesSaveOptions): string {
  return options.contentEncoding === 'base64' ? 'application/octet-stream' : 'text/plain;charset=utf-8';
}

export async function performFilesSave(
  options: SynapseFilesSaveOptions,
  downloads: DownloadsBackend = realDownloadsBackend,
): Promise<SynapseFilesSaveResult> {
  assertSafeRelativeFilename(options?.filename);
  const byteLength = contentByteLength(options);
  if (byteLength > MAX_SAVE_FILE_BYTES) {
    throw new Error(`files.save: content exceeds the ${MAX_SAVE_FILE_BYTES}-byte cap`);
  }
  const base64 = encodedPayload(options);

  const mimeType = options.mimeType ?? defaultMimeType(options);
  const downloadId = await downloads.download({
    url: `data:${mimeType};base64,${base64}`,
    filename: options.filename,
    saveAs: options.saveAs ?? false,
  });
  return { downloadId };
}
