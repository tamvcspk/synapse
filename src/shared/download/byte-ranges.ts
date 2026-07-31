/**
 * docs/ROADMAP.md §8.2/§11.2 — byte-range arithmetic shared by HLS's `#EXT-X-MAP` BYTERANGE handling
 * and the turbo (multi-connection Range) downloader, extracted out of utils/download-engine.ts
 * (Phase 1: "chunk/range math → shared/"). Global SDK (docs/design.md §9): pure, no `fetch`, no
 * `chrome.*` — these functions only produce/read the numbers and header strings, never issue a
 * request.
 */

/** HLS writes a byte range as `<length>[@<offset>]`; HTTP wants `bytes=<first>-<last>`. Returns
 * `undefined` for unparsable input, which the caller treats as "fetch the whole resource". */
export function byteRangeToHeader(byteRange: string): string | undefined {
  const [lengthText, offsetText] = byteRange.trim().split('@');
  const length = Number(lengthText);
  const offset = offsetText === undefined ? 0 : Number(offsetText);
  if (!Number.isFinite(length) || !Number.isFinite(offset) || length <= 0) return undefined;
  return `bytes=${offset}-${offset + length - 1}`;
}

export interface RangeChunk {
  index: number;
  /** Inclusive first byte. */
  start: number;
  /** Inclusive last byte — HTTP `Range` is inclusive on both ends, unlike every JS slice API. */
  end: number;
}

/**
 * docs/ROADMAP.md §8.2 — splits `totalBytes` into at most `chunkCount` contiguous, non-overlapping
 * inclusive ranges covering exactly `[0, totalBytes - 1]`. Fewer chunks than requested come back
 * when `chunkCount` doesn't divide `totalBytes` evenly and the tail chunk(s) would be empty — the
 * engine used to express that as a `start > end` early-return inside the fetch loop, which meant a
 * "chunk" that never existed still counted toward the pool's `Promise.all`. Producing only the real
 * chunks here makes that impossible to get wrong at the call site.
 */
export function planRangeChunks(totalBytes: number, chunkCount: number): RangeChunk[] {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0 || chunkCount <= 0) return [];
  const chunkSize = Math.ceil(totalBytes / chunkCount);
  const chunks: RangeChunk[] = [];
  for (let index = 0; index < chunkCount; index++) {
    const start = index * chunkSize;
    if (start >= totalBytes) break;
    chunks.push({ index, start, end: Math.min(start + chunkSize, totalBytes) - 1 });
  }
  return chunks;
}

export function rangeHeader(start: number, end: number): string {
  return `bytes=${start}-${end}`;
}

/** Reads the total size out of a `Content-Range: bytes 0-0/12345` response header. Returns
 * `undefined` for a missing header, an unknown total (`*`), or anything non-positive — every one of
 * which means "this server did not conclusively confirm a size", so the caller must fall back. */
export function parseContentRangeTotal(contentRange: string | null): number | undefined {
  if (!contentRange) return undefined;
  const total = Number(contentRange.split('/')[1]);
  return Number.isFinite(total) && total > 0 ? total : undefined;
}
