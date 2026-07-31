import { describe, expect, it } from 'vitest';
import { buildZip, type ZipEntryInput } from './zip';

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

const bytes = (s: string) => new TextEncoder().encode(s);

/**
 * Minimal independent ZIP reader — walks the central directory the way a real extractor does
 * (EOCD → central directory offset → each record → that record's local header offset), so the test
 * asserts against the format's own navigation rules rather than re-deriving buildZip's arithmetic.
 */
function readZip(zip: Uint8Array) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocdOffset = zip.length - 22;
  expect(view.getUint32(eocdOffset, true)).toBe(EOCD_SIGNATURE);

  const recordCount = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  expect(centralOffset + centralSize).toBe(eocdOffset);

  const decoder = new TextDecoder();
  const entries: { name: string; data: Uint8Array; crc: number; flags: number }[] = [];
  let pos = centralOffset;
  for (let i = 0; i < recordCount; i++) {
    expect(view.getUint32(pos, true)).toBe(CENTRAL_FILE_SIGNATURE);
    const flags = view.getUint16(pos + 8, true);
    const crc = view.getUint32(pos + 16, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const localOffset = view.getUint32(pos + 42, true);
    const name = decoder.decode(zip.subarray(pos + 46, pos + 46 + nameLength));

    // STORE method: the two sizes must agree, or extractors read past the entry.
    expect(compressedSize).toBe(uncompressedSize);

    expect(view.getUint32(localOffset, true)).toBe(LOCAL_FILE_SIGNATURE);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.push({ name, data: zip.subarray(dataStart, dataStart + uncompressedSize), crc, flags });

    pos += 46 + nameLength;
  }
  return { recordCount, entries };
}

describe('buildZip', () => {
  it('round-trips names and payload bytes through the central directory', () => {
    const input: ZipEntryInput[] = [
      { name: 'index.md', data: bytes('# Hello\n') },
      { name: 'images/photo.bin', data: new Uint8Array([0x00, 0xff, 0x10, 0x80]) },
    ];

    const { recordCount, entries } = readZip(buildZip(input));

    expect(recordCount).toBe(2);
    expect(entries.map((e) => e.name)).toEqual(['index.md', 'images/photo.bin']);
    expect(Array.from(entries[0]!.data)).toEqual(Array.from(input[0]!.data));
    expect(Array.from(entries[1]!.data)).toEqual(Array.from(input[1]!.data));
  });

  it('writes a correct CRC-32 (checked against the standard "123456789" test vector)', () => {
    const { entries } = readZip(buildZip([{ name: 'check.txt', data: bytes('123456789') }]));
    // CRC-32/ISO-HDLC of "123456789" — the canonical check value for this algorithm.
    expect(entries[0]!.crc).toBe(0xcbf43926);
  });

  it('sets the UTF-8 name flag so non-ASCII filenames survive extraction', () => {
    const { entries } = readZip(buildZip([{ name: 'Bài viết.md', data: bytes('x') }]));
    expect(entries[0]!.name).toBe('Bài viết.md');
    expect(entries[0]!.flags & 0x0800).toBe(0x0800);
  });

  it('produces a valid archive for zero entries and for zero-byte payloads', () => {
    const empty = readZip(buildZip([]));
    expect(empty.recordCount).toBe(0);
    expect(empty.entries).toEqual([]);

    const emptyFile = readZip(buildZip([{ name: 'empty.txt', data: new Uint8Array(0) }]));
    expect(emptyFile.recordCount).toBe(1);
    expect(emptyFile.entries[0]!.data).toHaveLength(0);
    // CRC-32 of the empty string is 0.
    expect(emptyFile.entries[0]!.crc).toBe(0);
  });

  it('is byte-for-byte deterministic when every entry carries an explicit date', () => {
    const date = new Date(2026, 6, 31, 12, 34, 56);
    const make = () => buildZip([{ name: 'a.txt', data: bytes('same'), date }]);
    expect(Array.from(make())).toEqual(Array.from(make()));
  });
});
