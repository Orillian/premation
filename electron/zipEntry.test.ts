/**
 * The one-member zip reader the ffmpeg repair extracts with.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractZipEntry, ZipError } from './zipEntry';
import { makeZip } from './__testHelpers__/makeZip';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'zipentry-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const payload = Buffer.from('ffmpeg binary bytes '.repeat(5000));

test('extracts a deflated member from a nested path, leaving the others', async () => {
  const zip = path.join(dir, 'a.zip');
  writeFileSync(zip, makeZip([
    { name: 'ffmpeg-x/LICENSE.txt', data: Buffer.from('GPL') },
    { name: 'ffmpeg-x/bin/ffmpeg.exe', data: payload },
  ]));
  const out = path.join(dir, 'ffmpeg.exe');
  await expect(extractZipEntry(zip, 'ffmpeg-x/bin/ffmpeg.exe', out)).resolves.toBe(payload.length);
  expect(readFileSync(out).equals(payload)).toBe(true);
});

test('extracts a stored member', async () => {
  const zip = path.join(dir, 's.zip');
  writeFileSync(zip, makeZip([{ name: 'ffmpeg', data: payload, store: true }]));
  const out = path.join(dir, 'ffmpeg');
  await extractZipEntry(zip, 'ffmpeg', out);
  expect(readFileSync(out).equals(payload)).toBe(true);
});

test('a member that is not there is a ZipError naming it', async () => {
  const zip = path.join(dir, 'a.zip');
  writeFileSync(zip, makeZip([{ name: 'other', data: payload }]));
  await expect(extractZipEntry(zip, 'ffmpeg', path.join(dir, 'x'))).rejects.toThrow(/"ffmpeg" is not in the archive/);
});

test('an HTML error page saved as .zip is a ZipError, not a crash', async () => {
  const zip = path.join(dir, 'portal.zip');
  writeFileSync(zip, '<html><body>Sign in to the hotel Wi-Fi</body></html>');
  await expect(extractZipEntry(zip, 'ffmpeg', path.join(dir, 'x'))).rejects.toBeInstanceOf(ZipError);
});

test('a truncated archive (download cut short) is a ZipError', async () => {
  const zip = path.join(dir, 't.zip');
  const full = makeZip([{ name: 'ffmpeg', data: payload }]);
  writeFileSync(zip, full.subarray(0, Math.floor(full.length / 2)));
  await expect(extractZipEntry(zip, 'ffmpeg', path.join(dir, 'x'))).rejects.toBeInstanceOf(ZipError);
});
