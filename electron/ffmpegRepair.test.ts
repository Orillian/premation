/**
 * "Download and fix" against a FAKE server: resume after a dropped connection,
 * mirrors, bad bytes, no network, a full disk, cancel, and a copy security
 * software will not let run.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReadableStream } from 'node:stream/web';
import type { FfmpegCandidateResult } from './ffmpegHealth';
import { classifyNetworkError, repairFfmpeg, RepairError, type PinnedBuild, type RepairDeps } from './ffmpegRepair';
import { makeZip } from './__testHelpers__/makeZip';

const BIN = Buffer.from('#!fake ffmpeg\n'.repeat(20000));
const ZIP = makeZip([{ name: 'pkg/bin/ffmpeg', data: BIN }]);
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const BUILD: PinnedBuild = {
  key: 'linux-x64',
  urls: ['https://mirror-a.test/ffmpeg.zip', 'https://mirror-b.test/ffmpeg.zip'],
  sha256: sha(ZIP),
  bytes: ZIP.length,
  installedBytes: BIN.length,
  entry: 'pkg/bin/ffmpeg',
};

let userData: string;
beforeEach(() => { userData = mkdtempSync(path.join(tmpdir(), 'ffrepair-')); });
afterEach(() => rmSync(userData, { recursive: true, force: true }));

/** A Response whose body yields `bytes` in chunks, optionally erroring after `dropAfter` bytes. */
function respond(status: number, bytes: Buffer, dropAfter?: number): Response {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (dropAfter !== undefined && sent >= dropAfter) {
        ctrl.error(Object.assign(new Error('net::ERR_CONNECTION_CLOSED'), {}));
        return;
      }
      if (sent >= bytes.length) { ctrl.close(); return; }
      const end = Math.min(bytes.length, sent + 16384, dropAfter ?? Infinity);
      ctrl.enqueue(new Uint8Array(bytes.subarray(sent, end)));
      sent = end;
    },
  });
  // Only what the repair reads; jest's jsdom has no fetch Response.
  return { status, body } as unknown as Response;
}

type Handler = (url: string, range: number | null, call: number) => Response | Error;

function makeDeps(handler: Handler, extra: Partial<RepairDeps> = {}): RepairDeps & { calls: Array<{ url: string; range: number | null }> } {
  const calls: Array<{ url: string; range: number | null }> = [];
  const verify = async (bin: string): Promise<FfmpegCandidateResult> => ({
    source: 'repaired', path: bin, runs: readFileSync(bin).equals(BIN), encoders: ['libx264'], missingEncoders: [],
  });
  return {
    calls,
    userDataPath: userData,
    platform: 'linux',
    arch: 'x64',
    build: BUILD,
    fetch: async (url, init) => {
      const m = /bytes=(\d+)-/.exec(init.headers?.Range ?? '');
      const range = m ? Number(m[1]) : null;
      calls.push({ url, range });
      const r = handler(url, range, calls.length);
      if (r instanceof Error) throw r;
      return r;
    },
    freeBytes: async () => 10 * 1024 * 1024 * 1024,
    verify,
    sleep: async () => undefined,
    ...extra,
  };
}

const installedAt = (): string => path.join(userData, 'tools', 'ffmpeg', BUILD.sha256.slice(0, 16), 'ffmpeg');

test('downloads, checks, installs into the pin folder and deletes the archive', async () => {
  const progress: string[] = [];
  const d = makeDeps(() => respond(200, ZIP), { onProgress: (p) => progress.push(p.phase) });
  await expect(repairFfmpeg(d)).resolves.toBe(installedAt());
  expect(readFileSync(installedAt()).equals(BIN)).toBe(true);
  expect(readdirSync(path.join(userData, 'tools', 'ffmpeg'))).toEqual([BUILD.sha256.slice(0, 16)]);
  expect(progress).toEqual(expect.arrayContaining(['checking-space', 'downloading', 'verifying', 'installing', 'testing']));
});

test('a dropped connection resumes from where it stopped (HTTP Range)', async () => {
  const half = Math.floor(ZIP.length / 2);
  const d = makeDeps((_u, range, call) => {
    if (call === 1) return respond(200, ZIP, half);
    return respond(206, ZIP.subarray(range ?? 0));
  });
  await repairFfmpeg(d);
  expect(d.calls[1]!.range).toBe(half);
  expect(readFileSync(installedAt()).equals(BIN)).toBe(true);
});

test('a server that ignores Range (200) restarts cleanly instead of appending', async () => {
  const d = makeDeps((_u, _r, call) => (call === 1 ? respond(200, ZIP, 1000) : respond(200, ZIP)));
  await repairFfmpeg(d);
  expect(readFileSync(installedAt()).equals(BIN)).toBe(true);
});

test('a 404 mirror is skipped for the next one', async () => {
  const d = makeDeps((url) => (url.includes('mirror-a') ? respond(404, Buffer.alloc(0)) : respond(200, ZIP)));
  await repairFfmpeg(d);
  expect(d.calls.map((c) => new URL(c.url).host)).toEqual(['mirror-a.test', 'mirror-b.test']);
});

test('bytes that never match the pin (captive portal) end as "corrupted", nothing installed', async () => {
  const portal = Buffer.alloc(ZIP.length, 0x3c);
  const d = makeDeps(() => respond(200, portal));
  await expect(repairFfmpeg(d)).rejects.toMatchObject({ code: 'corrupted' });
  expect(existsSync(installedAt())).toBe(false);
});

test('no network: "offline", after a quick second try', async () => {
  const d = makeDeps(() => new Error('net::ERR_INTERNET_DISCONNECTED'));
  await expect(repairFfmpeg(d)).rejects.toMatchObject({ code: 'offline' });
});

test('not enough disk space is refused before downloading, with the amount needed', async () => {
  const d = makeDeps(() => respond(200, ZIP), { freeBytes: async () => 1000 });
  const err = await repairFfmpeg(d).catch((e: RepairError) => e);
  expect(err).toBeInstanceOf(RepairError);
  expect((err as RepairError).code).toBe('disk-full');
  expect((err as RepairError).neededBytes).toBeGreaterThan(ZIP.length);
  expect(d.calls).toHaveLength(0);
});

test('cancel stops it and reports cancelled', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const d = makeDeps(() => respond(200, ZIP), { signal: ctrl.signal });
  await expect(repairFfmpeg(d)).rejects.toMatchObject({ code: 'cancelled' });
});

test('a correct download that will not run here (antivirus) is "blocked-after-install"', async () => {
  const d = makeDeps(() => respond(200, ZIP), {
    verify: async (bin) => ({ source: 'repaired', path: bin, runs: false, encoders: [], missingEncoders: ['libx264'], code: 'blocked', detail: 'EPERM' }),
  });
  await expect(repairFfmpeg(d)).rejects.toMatchObject({ code: 'blocked-after-install' });
  expect(existsSync(installedAt())).toBe(false);
});

test('unsupported platform', async () => {
  const d = makeDeps(() => respond(200, ZIP), { build: undefined, platform: 'linux', arch: 'riscv64' });
  await expect(repairFfmpeg(d)).rejects.toMatchObject({ code: 'unsupported' });
});

test('network error classification', () => {
  expect(classifyNetworkError(new Error('net::ERR_NAME_NOT_RESOLVED'))).toBe('offline');
  expect(classifyNetworkError(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }))).toBe('offline');
  expect(classifyNetworkError(new Error('net::ERR_PROXY_CONNECTION_FAILED'))).toBe('network-blocked');
  expect(classifyNetworkError(new Error('net::ERR_CERT_AUTHORITY_INVALID'))).toBe('network-blocked');
  expect(classifyNetworkError(new Error('net::ERR_TIMED_OUT'))).toBe('stalled');
});
