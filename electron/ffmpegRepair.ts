/**
 * "Download and fix": fetch the pinned ffmpeg (electron/ffmpegManifest.json —
 * the same bytes the installer ships) into `<userData>/tools/ffmpeg/<pin>/`,
 * check it, and make it the copy exports use.
 *
 * Written for people who will not read an error code, so every way it can go
 * wrong ends in a RepairError with a `code` the UI turns into one sentence and
 * one next step:
 *
 *   offline         no network at all                      → connect, Try again
 *   network-blocked a proxy / firewall / TLS inspector refused → Choose file… (download elsewhere)
 *   unavailable     every mirror answered 404/5xx           → Try later / Choose file…
 *   stalled         the transfer stopped moving              → Try again (resumes)
 *   disk-full       not enough free space                   → free N MB, Try again
 *   no-permission   the app folder is not writable           → Choose file… / admin
 *   corrupted       the bytes never matched the pin          → Try again later
 *   blocked-after-install  saved, but security software stops it running → allow it
 *   cancelled       the person pressed Cancel
 *   unsupported     no pinned build for this platform/arch
 *
 * The download resumes (HTTP Range) after a dropped connection, retries each
 * mirror with backoff, and never leaves a half-written file where a check
 * would mistake it for a good one: .part → SHA-256 → extract to a staging
 * folder → run it → rename into place.
 *
 * Electron-free: fetch (main passes Electron's `net.fetch`, which honours the
 * system proxy and certificate store — what makes corporate networks work),
 * the filesystem queries and the verifier are injected.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ffmpegExeName, ffmpegToolsDir } from './ffmpegBinary';
import type { FfmpegCandidateResult } from './ffmpegHealth';
import manifest from './ffmpegManifest.json';
import { extractZipEntry, ZipError } from './zipEntry';

export type RepairErrorCode =
  | 'offline' | 'network-blocked' | 'unavailable' | 'stalled' | 'disk-full' | 'no-permission'
  | 'corrupted' | 'blocked-after-install' | 'cancelled' | 'unsupported';

export class RepairError extends Error {
  constructor(readonly code: RepairErrorCode, readonly detail: string, readonly neededBytes?: number) {
    super(detail);
  }
}

export interface RepairProgress {
  phase: 'checking-space' | 'downloading' | 'verifying' | 'installing' | 'testing';
  receivedBytes: number;
  totalBytes: number;
  /** Which attempt, for "Retrying (2 of 3)…". */
  attempt: number;
}

export interface PinnedBuild {
  key: string;
  urls: string[];
  sha256: string;
  bytes: number;
  installedBytes: number;
  entry: string;
}

/** The archive's container, from the pinned URL: the Linux pin is a .tar.xz (BtbN), every other pin a zip. */
export function archiveExtension(build: Pick<PinnedBuild, 'urls'>): 'zip' | 'tar.xz' {
  return /\.tar\.xz$/i.test(build.urls[0] ?? '') ? 'tar.xz' : 'zip';
}

/**
 * One member of a .tar.xz, through the system `tar` — Node has no xz. Only the
 * Linux pin is a tarball, and tar + xz are on every Linux desktop the app runs
 * on; the zip pins keep the in-process extractor (zipEntry.ts).
 */
async function extractTarEntry(archive: string, name: string, outDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('tar', ['-xf', archive, '-C', outDir, name], { windowsHide: true }, (err, _stdout, stderr) => {
      if (err) reject(new ZipError(`tar could not extract ${name}: ${String(stderr || err.message).trim()}`));
      else resolve();
    });
  });
  if (!existsSync(path.join(outDir, name))) throw new ZipError(`${name} is not in ${path.basename(archive)}`);
}

export function pinnedBuild(platform: NodeJS.Platform, arch: string): PinnedBuild | null {
  const key = `${platform}-${arch}`;
  const b = (manifest.builds as Record<string, Omit<PinnedBuild, 'key'> | undefined>)[key];
  return b ? { key, ...b } : null;
}

type FetchLike = (url: string, init: { headers?: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export interface RepairDeps {
  userDataPath: string;
  platform: NodeJS.Platform;
  arch: string;
  fetch: FetchLike;
  /** Free bytes on the volume holding `dir`; null when unknown (the check is skipped). */
  freeBytes: (dir: string) => Promise<number | null>;
  /** Run the installed copy (ffmpegHealth.probeCandidate). */
  verify: (bin: string) => Promise<FfmpegCandidateResult>;
  onProgress?: (p: RepairProgress) => void;
  signal?: AbortSignal;
  /** Attempts per mirror. */
  attempts?: number;
  /** No bytes for this long → abort the transfer and retry (resuming). */
  stallMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
  /** Tests: a build other than the manifest's pin. */
  build?: PinnedBuild;
}

const MB = 1024 * 1024;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Chromium (`net::ERR_*`) and Node (`ENOTFOUND`, `CERT_*`) network failures → code. */
export function classifyNetworkError(err: unknown): RepairErrorCode {
  const e = err as { code?: string; cause?: { code?: string; message?: string }; message?: string; name?: string };
  const text = `${e?.code ?? ''} ${e?.cause?.code ?? ''} ${e?.message ?? ''} ${e?.cause?.message ?? ''}`;
  if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH/.test(text)) return 'offline';
  if (/ERR_PROXY|ERR_TUNNEL|ERR_CERT|ERR_SSL|ERR_BLOCKED|ERR_ACCESS_DENIED|ERR_CONNECTION_RESET|CERT_|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ECONNRESET|EPROTO/.test(text)) return 'network-blocked';
  return 'stalled';  // timed out / connection refused / dropped mid-way: a retry (with resume) is the fix
}

/** A filesystem write failure → code. */
export function classifyFsError(err: unknown): RepairErrorCode | null {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'disk-full';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'no-permission';
  return null;
}

async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

/**
 * Download `url` into `part`, resuming from what is already there. Resolves
 * when the server says the file is complete; throws RepairError otherwise.
 */
async function transfer(url: string, part: string, build: PinnedBuild, attempt: number, deps: RepairDeps): Promise<void> {
  let have = await sizeOf(part);
  if (have > build.bytes) {
    await rm(part, { force: true });
    have = 0;
  }
  if (have === build.bytes) return;
  const ctrl = new AbortController();
  const outer = deps.signal;
  const onOuter = (): void => ctrl.abort();
  outer?.addEventListener('abort', onOuter);
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let stalled = false;
  const arm = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => { stalled = true; ctrl.abort(); }, deps.stallMs ?? 45_000);
  };
  try {
    arm();
    let res: Response;
    try {
      res = await deps.fetch(url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {}, signal: ctrl.signal });
    } catch (err) {
      if (outer?.aborted) throw new RepairError('cancelled', 'cancelled');
      if (stalled) throw new RepairError('stalled', `no response from ${new URL(url).host}`);
      throw new RepairError(classifyNetworkError(err), `${new URL(url).host}: ${(err as Error).message}`);
    }
    if (res.status === 416) return;  // nothing left to send: the .part is whole
    if (res.status !== 200 && res.status !== 206) {
      throw new RepairError(RETRYABLE_STATUS.has(res.status) ? 'stalled' : 'unavailable', `${new URL(url).host} answered ${res.status}`);
    }
    if (!res.body) throw new RepairError('unavailable', `${new URL(url).host} sent no body`);
    // 200 to a Range request: the server ignored it — start over.
    const append = res.status === 206 && have > 0;
    if (!append) have = 0;
    const out = createWriteStream(part, { flags: append ? 'a' : 'w' });
    // A write failure (disk full mid-download) arrives as an 'error' event: catch
    // it from the start — an unheard 'error' would take the main process down.
    let writeErr: NodeJS.ErrnoException | null = null;
    out.on('error', (e) => { writeErr = e; ctrl.abort(); });
    let received = have;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (writeErr) break;
        arm();
        received += value.byteLength;
        if (!out.write(value)) {
          // Backpressure. One listener pair per wait, both removed after —
          // a 190 MB download waits thousands of times.
          await new Promise<void>((r) => {
            const done = (): void => {
              out.off('drain', done);
              out.off('error', done);
              r();
            };
            out.on('drain', done);
            out.on('error', done);
          });
        }
        deps.onProgress?.({ phase: 'downloading', receivedBytes: received, totalBytes: build.bytes, attempt });
      }
    } catch (err) {
      if (outer?.aborted) throw new RepairError('cancelled', 'cancelled');
      if (writeErr) throw new RepairError(classifyFsError(writeErr) ?? 'no-permission', (writeErr as Error).message);
      if (stalled) throw new RepairError('stalled', `the download from ${new URL(url).host} stopped moving`);
      // Bytes already flowed, so the network does allow it: a reset now is a
      // dropped connection to resume, not a filter blocking the host.
      if (received > have) throw new RepairError('stalled', `${new URL(url).host}: ${(err as Error).message}`);
      throw new RepairError(classifyNetworkError(err), `${new URL(url).host}: ${(err as Error).message}`);
    } finally {
      if (!writeErr) await new Promise<void>((resolve) => out.end(() => resolve()));
      else out.destroy();
    }
    if (writeErr) throw new RepairError(classifyFsError(writeErr) ?? 'no-permission', (writeErr as Error).message);
    if (received < build.bytes) throw new RepairError('stalled', `the download ended early (${received} of ${build.bytes} bytes)`);
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    outer?.removeEventListener('abort', onOuter);
  }
}

/** Get the verified archive into `archive`, trying each mirror with retries and resume. */
async function fetchArchive(build: PinnedBuild, archive: string, deps: RepairDeps): Promise<void> {
  const part = `${archive}.part`;
  if (existsSync(archive) && (await sha256File(archive)) === build.sha256) return;
  const attempts = deps.attempts ?? 3;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: RepairError = new RepairError('unavailable', 'no download source');
  let tries = 0;
  for (const url of build.urls) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      tries += 1;
      if (deps.signal?.aborted) throw new RepairError('cancelled', 'cancelled');
      try {
        await transfer(url, part, build, tries, deps);
      } catch (err) {
        last = err instanceof RepairError ? err : new RepairError('stalled', String((err as Error)?.message ?? err));
        deps.log?.(`ffmpeg repair: ${url} attempt ${attempt}: ${last.code} — ${last.detail}`);
        // Nothing a retry can change: stop now.
        if (last.code === 'cancelled' || last.code === 'disk-full' || last.code === 'no-permission') throw last;
        if (last.code === 'unavailable') break;  // next mirror
        if (last.code === 'offline' && attempt === 1) {
          // One quick second try: Wi-Fi reconnecting is common.
          await sleep(2000);
          continue;
        }
        if (attempt < attempts) await sleep(Math.min(2000 * 2 ** (attempt - 1), 15_000));
        continue;
      }
      deps.onProgress?.({ phase: 'verifying', receivedBytes: build.bytes, totalBytes: build.bytes, attempt: tries });
      if ((await sha256File(part)) === build.sha256) {
        await rename(part, archive);
        return;
      }
      // Wrong bytes: a captive portal page, a truncated CDN object, tampering. Never resume from them.
      await rm(part, { force: true });
      last = new RepairError('corrupted', `the file from ${new URL(url).host} did not match the expected SHA-256`);
      deps.log?.(`ffmpeg repair: ${last.detail}`);
    }
  }
  throw last;
}

/** Remove other pins' folders and leftovers (best effort; a running old copy on Windows stays until next time). */
async function cleanup(dir: string, keep: string): Promise<void> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (n === keep || n === 'choice.json') continue;
    await rm(path.join(dir, n), { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Install from an archive already on disk — the download path's second half, and "Choose file…" with the zip. */
export async function installFromArchive(archive: string, build: PinnedBuild, deps: RepairDeps): Promise<string> {
  const dir = ffmpegToolsDir(deps.userDataPath);
  const pinDir = build.sha256.slice(0, 16);
  const staging = path.join(dir, `${pinDir}.staging`);
  const finalDir = path.join(dir, pinDir);
  const exe = ffmpegExeName(deps.platform);
  deps.onProgress?.({ phase: 'installing', receivedBytes: build.bytes, totalBytes: build.bytes, attempt: 1 });
  try {
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    if (archiveExtension(build) === 'tar.xz') {
      const unpack = path.join(staging, 'unpack');
      await mkdir(unpack, { recursive: true });
      await extractTarEntry(archive, build.entry, unpack);
      await rename(path.join(unpack, build.entry), path.join(staging, exe));
      await rm(unpack, { recursive: true, force: true });
    } else {
      await extractZipEntry(archive, build.entry, path.join(staging, exe));
    }
    if (deps.platform !== 'win32') await chmod(path.join(staging, exe), 0o755);
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    const fsCode = classifyFsError(err);
    if (fsCode) throw new RepairError(fsCode, (err as Error).message, build.installedBytes);
    if (err instanceof ZipError) throw new RepairError('corrupted', err.message);
    throw err;
  }
  deps.onProgress?.({ phase: 'testing', receivedBytes: build.bytes, totalBytes: build.bytes, attempt: 1 });
  const result = await deps.verify(path.join(staging, exe));
  if (!result.runs || result.missingEncoders.length > 0) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    // It was the right file (hash-checked) and it still does not run here:
    // something on this machine stops it — vanished (quarantined), refused, or
    // killed — whatever the OS calls it.
    const code: RepairErrorCode = result.runs ? 'corrupted' : 'blocked-after-install';
    throw new RepairError(code, `the downloaded ffmpeg does not run: ${result.code ?? 'incomplete'} ${result.detail ?? ''}`.trim());
  }
  try {
    await rm(finalDir, { recursive: true, force: true });
    await rename(staging, finalDir);
  } catch (err) {
    // A previous copy of this very pin is running (Windows locks it). It is the same bytes — use it.
    if (existsSync(path.join(finalDir, exe))) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    } else {
      const fsCode = classifyFsError(err);
      throw new RepairError(fsCode ?? 'no-permission', (err as Error).message);
    }
  }
  await cleanup(dir, pinDir);
  return path.join(finalDir, exe);
}

/** The whole repair. Resolves with the installed executable's path. */
export async function repairFfmpeg(deps: RepairDeps): Promise<string> {
  const build = deps.build ?? pinnedBuild(deps.platform, deps.arch);
  if (!build) throw new RepairError('unsupported', `no ffmpeg is published for ${deps.platform}-${deps.arch}`);
  const dir = ffmpegToolsDir(deps.userDataPath);
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    throw new RepairError(classifyFsError(err) ?? 'no-permission', (err as Error).message);
  }
  const archive = path.join(dir, `${build.sha256.slice(0, 16)}.${archiveExtension(build)}`);
  deps.onProgress?.({ phase: 'checking-space', receivedBytes: 0, totalBytes: build.bytes, attempt: 1 });
  const already = Math.max(await sizeOf(`${archive}.part`), await sizeOf(archive));
  const needed = (build.bytes - Math.min(already, build.bytes)) + build.installedBytes + 50 * MB;
  const free = await deps.freeBytes(dir).catch(() => null);
  if (free !== null && free < needed) {
    throw new RepairError('disk-full', `${Math.ceil(needed / MB)} MB needed, ${Math.floor(free / MB)} MB free`, needed);
  }
  await fetchArchive(build, archive, deps);
  const installed = await installFromArchive(archive, build, deps);
  await rm(archive, { force: true }).catch(() => undefined);  // ~190 MB on Windows: do not keep it
  return installed;
}
