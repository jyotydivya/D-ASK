// Minimal read-only ZIP reader (enough for .docx): central directory, stored and deflated entries. Uses only node:zlib, so the
// packaged agent host needs no extra module. Bounded: entries larger than MAX_ENTRY_BYTES are refused, never inflated.

import zlib from "node:zlib";

const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

export interface ZipEntry { name: string; method: number; compressedSize: number; size: number; localOffset: number }

export function zipEntries(buf: Buffer): ZipEntry[] {
  // End of central directory: last 22..65557 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    out.push({ name, method, compressedSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  if (entry.size > MAX_ENTRY_BYTES) throw new Error(`zip entry ${entry.name} is too large`);
  const p = entry.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) throw new Error("corrupt zip local header");
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
  throw new Error(`unsupported zip compression method ${entry.method}`);
}

export function readZipFile(buf: Buffer, name: string): Buffer | null {
  const e = zipEntries(buf).find((x) => x.name === name);
  return e ? readZipEntry(buf, e) : null;
}
