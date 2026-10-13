/**
 * Extract ONE member of a zip archive to a file — what the ffmpeg repair needs
 * (electron/ffmpegRepair.ts), without shelling out to `tar` / `unzip`, which a
 * user's machine may not have (Windows before 1803 has no tar.exe; a locked-down
 * PC may block it).
 *
 * Reads the central directory (the authoritative list; local headers can carry
 * zero sizes when the writer streamed), then inflates the member's data straight
 * to disk. Stored (0) and deflate (8) only — every archive we pin uses those —
 * and classic 32-bit offsets plus the zip64 end-of-directory record, so an
 * archive over 4 GB is read correctly rather than misread.
 *
 * Electron-free.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export class ZipError extends Error {}

interface Entry {
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

async function readAt(fd: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fd.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

/** The zip64 extended-information extra field fills in whichever 32-bit fields were 0xFFFFFFFF. */
function applyZip64(extra: Buffer, e: Entry): void {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    if (id === 0x0001) {
      let q = p + 4;
      if (e.size === 0xffffffff) { e.size = Number(extra.readBigUInt64LE(q)); q += 8; }
      if (e.compressedSize === 0xffffffff) { e.compressedSize = Number(extra.readBigUInt64LE(q)); q += 8; }
      if (e.localHeaderOffset === 0xffffffff) e.localHeaderOffset = Number(extra.readBigUInt64LE(q));
      return;
    }
    p += 4 + len;
  }
}

async function findEntry(archive: string, name: string): Promise<Entry> {
  const fd = await open(archive, 'r');
  try {
    const { size } = await fd.stat();
    // The end-of-central-directory record is 22 bytes plus a comment of up to 64 KiB.
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = await readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new ZipError('not a zip archive (no end-of-directory record) — the download is incomplete or is not the archive');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || count === 0xffff) {
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== ZIP64_LOCATOR_SIG) throw new ZipError('zip64 archive without its locator');
      const z64At = Number(tail.readBigUInt64LE(loc + 8));
      const z64 = await readAt(fd, z64At, 56);
      if (z64.readUInt32LE(0) !== ZIP64_EOCD_SIG) throw new ZipError('zip64 end-of-directory record not found');
      count = Number(z64.readBigUInt64LE(32));
      cdSize = Number(z64.readBigUInt64LE(40));
      cdOffset = Number(z64.readBigUInt64LE(48));
    }
    const cd = await readAt(fd, cdOffset, cdSize);
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== CDIR_SIG) throw new ZipError('corrupt central directory');
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const entryName = cd.toString('utf8', p + 46, p + 46 + nameLen);
      if (entryName === name) {
        const e: Entry = {
          method: cd.readUInt16LE(p + 10),
          compressedSize: cd.readUInt32LE(p + 20),
          size: cd.readUInt32LE(p + 24),
          localHeaderOffset: cd.readUInt32LE(p + 42),
        };
        applyZip64(cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), e);
        // The data starts after the LOCAL header, whose name/extra lengths may differ from the central copy.
        const local = await readAt(fd, e.localHeaderOffset, 30);
        if (local.length < 30 || local.readUInt32LE(0) !== LOCAL_SIG) throw new ZipError('corrupt local header');
        e.localHeaderOffset += 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        return e;
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    throw new ZipError(`"${name}" is not in the archive`);
  } finally {
    await fd.close();
  }
}

/** Write member `name` of `archive` to `outFile`. Throws ZipError on a malformed archive or size mismatch. */
export async function extractZipEntry(archive: string, name: string, outFile: string): Promise<number> {
  const e = await findEntry(archive, name);
  if (e.method !== 0 && e.method !== 8) throw new ZipError(`"${name}" uses compression method ${e.method}, which is not supported`);
  const source = e.compressedSize === 0
    ? null
    : createReadStream(archive, { start: e.localHeaderOffset, end: e.localHeaderOffset + e.compressedSize - 1 });
  const out = createWriteStream(outFile);
  let written = 0;
  if (source === null) {
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } else if (e.method === 0) {
    source.on('data', (c: Buffer | string) => { written += c.length; });
    await pipeline(source, out);
  } else {
    const inflate = createInflateRaw();
    inflate.on('data', (c: Buffer) => { written += c.length; });
    await pipeline(source, inflate, out);
  }
  if (written !== e.size) throw new ZipError(`"${name}" extracted to ${written} bytes, expected ${e.size}`);
  return written;
}
