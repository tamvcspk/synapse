/**
 * Global SDK (docs/design.md §9): pure, no DOM/chrome APIs/I-O — bytes in, bytes out. Hand-rolled
 * rather than a dependency (docs/ROADMAP.md #3's Review page) since the STORE (uncompressed)
 * method is simple to implement correctly and images/markdown here don't benefit much from
 * further compression anyway (images are already-compressed formats; markdown text is small).
 */

export interface ZipEntryInput {
  name: string;
  data: Uint8Array;
  /** Defaults to the current time if omitted — callers that want a deterministic archive should
   * pass a fixed Date explicitly. */
  date?: Date;
}

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
// General-purpose bit 11 ("Language encoding flag / EFS") tells extractors the filename is UTF-8,
// not the legacy CP437 — matters since a page's title/images can carry non-ASCII characters.
const UTF8_NAME_FLAG = 0x0800;

let crcTable: Uint32Array | undefined;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(data: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time fields used throughout the ZIP format (16 bits each). */
function toDosDateTime(date: Date): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: dosDate & 0xffff };
}

interface PreparedEntry {
  nameBytes: Uint8Array;
  data: Uint8Array;
  crc: number;
  dosTime: number;
  dosDate: number;
  localHeaderOffset: number;
}

/** Builds a STORE-method (uncompressed) ZIP archive from the given entries — a minimal but valid
 * ZIP: local file header + raw data per entry, followed by one central directory. */
export function buildZip(entries: ZipEntryInput[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const now = new Date();

  const prepared: PreparedEntry[] = [];
  let offset = 0;
  let localSectionSize = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const { time, date } = toDosDateTime(entry.date ?? now);
    prepared.push({
      nameBytes,
      data: entry.data,
      crc: crc32(entry.data),
      dosTime: time,
      dosDate: date,
      localHeaderOffset: offset,
    });
    const entrySize = 30 + nameBytes.length + entry.data.length;
    offset += entrySize;
    localSectionSize += entrySize;
  }

  const centralSectionSize = prepared.reduce((sum, e) => sum + 46 + e.nameBytes.length, 0);
  const totalSize = localSectionSize + centralSectionSize + 22;

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);
  let pos = 0;

  for (const entry of prepared) {
    view.setUint32(pos, LOCAL_FILE_SIGNATURE, true);
    view.setUint16(pos + 4, 20, true); // version needed to extract
    view.setUint16(pos + 6, UTF8_NAME_FLAG, true);
    view.setUint16(pos + 8, 0, true); // compression method: stored
    view.setUint16(pos + 10, entry.dosTime, true);
    view.setUint16(pos + 12, entry.dosDate, true);
    view.setUint32(pos + 14, entry.crc, true);
    view.setUint32(pos + 18, entry.data.length, true); // compressed size == uncompressed (stored)
    view.setUint32(pos + 22, entry.data.length, true);
    view.setUint16(pos + 26, entry.nameBytes.length, true);
    view.setUint16(pos + 28, 0, true); // extra field length
    pos += 30;
    out.set(entry.nameBytes, pos);
    pos += entry.nameBytes.length;
    out.set(entry.data, pos);
    pos += entry.data.length;
  }

  const centralDirectoryOffset = pos;
  for (const entry of prepared) {
    view.setUint32(pos, CENTRAL_FILE_SIGNATURE, true);
    view.setUint16(pos + 4, 20, true); // version made by
    view.setUint16(pos + 6, 20, true); // version needed to extract
    view.setUint16(pos + 8, UTF8_NAME_FLAG, true);
    view.setUint16(pos + 10, 0, true); // compression method: stored
    view.setUint16(pos + 12, entry.dosTime, true);
    view.setUint16(pos + 14, entry.dosDate, true);
    view.setUint32(pos + 16, entry.crc, true);
    view.setUint32(pos + 20, entry.data.length, true);
    view.setUint32(pos + 24, entry.data.length, true);
    view.setUint16(pos + 28, entry.nameBytes.length, true);
    view.setUint16(pos + 30, 0, true); // extra field length
    view.setUint16(pos + 32, 0, true); // file comment length
    view.setUint16(pos + 34, 0, true); // disk number start
    view.setUint16(pos + 36, 0, true); // internal file attributes
    view.setUint32(pos + 38, 0, true); // external file attributes
    view.setUint32(pos + 42, entry.localHeaderOffset, true);
    pos += 46;
    out.set(entry.nameBytes, pos);
    pos += entry.nameBytes.length;
  }

  view.setUint32(pos, EOCD_SIGNATURE, true);
  view.setUint16(pos + 4, 0, true); // disk number
  view.setUint16(pos + 6, 0, true); // disk where central directory starts
  view.setUint16(pos + 8, prepared.length, true); // records on this disk
  view.setUint16(pos + 10, prepared.length, true); // total records
  view.setUint32(pos + 12, centralSectionSize, true);
  view.setUint32(pos + 16, centralDirectoryOffset, true);
  view.setUint16(pos + 20, 0, true); // comment length

  return out;
}
