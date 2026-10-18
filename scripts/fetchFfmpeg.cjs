/**
 * Fetch, verify and stage the ffmpeg executable that export encodes with.
 *
 * Export runs ffmpeg as a separate program (electron/ffmpegBinary.ts); without
 * a bundled copy an installed app falls back to `ffmpeg` on PATH, which most
 * people do not have — export then fails after the whole render. So packaging
 * REQUIRES it, like the engine (scripts/stageEngine.cjs):
 *
 *   1. download the archive pinned in electron/ffmpegManifest.json for this
 *      platform + arch into build/.cache/ffmpeg/ (once; reused afterwards),
 *   2. check its SHA-256 against the pin — a moved, truncated or tampered
 *      download fails here, never in a user's export,
 *   3. extract only the ffmpeg executable,
 *   4. run it (when this machine can) and check every encoder export uses is
 *      compiled in (manifest `requiredEncoders`),
 *   5. stage it into build/ffmpeg/ with LICENSE.txt + NOTICE.txt
 *      (resources/ffmpeg/), which electron-builder.yml ships as
 *      <resources>/ffmpeg/.
 *
 * Steps 1–4 fail the build loudly. `PREMATION_PACKAGE_WITHOUT_FFMPEG=1` allows a
 * local rehearsal offline (the app then offers the in-app repair download on
 * first export); CI ignores it.
 *
 *   node scripts/fetchFfmpeg.cjs                 this machine's platform + arch
 *   node scripts/fetchFfmpeg.cjs darwin arm64    one target
 *   node scripts/fetchFfmpeg.cjs --all           every pinned target (bumping the pin)
 */

'use strict';

const { chmodSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MANIFEST = require('../electron/ffmpegManifest.json');

/** electron-builder's Arch enum (builder-util): ia32 0, x64 1, armv7l 2, arm64 3, universal 4. */
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };
const archName = (arch) => (typeof arch === 'number' ? ARCH_NAMES[arch] ?? String(arch) : arch || process.arch);
const exeName = (platform) => (platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

/** The pinned build for one platform + arch, or a thrown error naming what IS pinned. */
function buildFor(platform, arch) {
  const key = `${platform}-${arch}`;
  const b = MANIFEST.builds[key];
  if (!b) throw new Error(`[ffmpeg] no ffmpeg is pinned for ${key} (pinned: ${Object.keys(MANIFEST.builds).join(', ')}) — add it to electron/ffmpegManifest.json`);
  return { key, ...b };
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const ATTEMPTS = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt) => Math.min(2000 * 2 ** (attempt - 1), 30_000) + Math.floor(Math.random() * 1000);

async function sha256File(file) {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

/** Download `url` to `dest` (streamed; write-then-rename). Retries transient failures. */
async function downloadOnce(url, dest) {
  let lastErr;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok || !res.body) {
        lastErr = new Error(`${url} answered ${res.status}`);
        if (!RETRYABLE.has(res.status)) break;  // a 404 means the pin moved: fail now, not after a minute
      } else {
        const tmp = `${dest}.part`;
        await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
        renameSync(tmp, dest);
        return;
      }
    } catch (err) {
      lastErr = err;  // a dropped connection is as transient as a 503
    }
    if (attempt < ATTEMPTS) {
      const wait = backoff(attempt);
      console.log(`[ffmpeg] ${lastErr.message}; retrying in ${Math.round(wait / 1000)}s (attempt ${attempt}/${ATTEMPTS})`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/** The archive's container, from the pinned URL: BtbN's Linux builds are .tar.xz, everything else is a zip. */
const archiveExt = (build) => (/\.tar\.xz$/i.test(build.urls[0]) ? 'tar.xz' : 'zip');

/** The verified archive in the cache, downloading it from the first mirror that serves the pinned bytes. */
async function ensureArchive(build, cacheDir) {
  mkdirSync(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, `${build.sha256}.${archiveExt(build)}`);
  if (existsSync(archive) && (await sha256File(archive)) === build.sha256) return archive;
  const failures = [];
  for (const url of build.urls) {
    console.log(`[ffmpeg] downloading ${build.key} (${(build.bytes / 1e6).toFixed(0)} MB) from ${new URL(url).host} …`);
    try {
      await downloadOnce(url, archive);
    } catch (err) {
      failures.push(`${url}: ${err.message}`);
      continue;
    }
    const got = await sha256File(archive);
    if (got === build.sha256) return archive;
    rmSync(archive, { force: true });
    failures.push(`${url}: SHA-256 ${got} does not match the pin ${build.sha256}`);
  }
  throw new Error(`[ffmpeg] could not get the pinned ffmpeg for ${build.key}:\n  ${failures.join('\n  ')}`);
}

/**
 * Extract one archive member to `outFile` with the OS's own tools: bsdtar on
 * Windows (never Git's GNU tar, which cannot read zip; it reads .tar.xz too),
 * `unzip` for a zip elsewhere, and `tar` for a .tar.xz (GNU tar + xz on the
 * Linux runner; bsdtar on macOS).
 */
function extractEntry(archive, entry, outFile) {
  const tmpDir = `${outFile}.x`;
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  if (process.platform === 'win32') {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-xf', archive, '-C', tmpDir, entry], { stdio: 'pipe' });
  } else if (/\.tar\.xz$/i.test(archive)) {
    execFileSync('tar', ['-xf', archive, '-C', tmpDir, entry], { stdio: 'pipe' });
  } else {
    execFileSync('unzip', ['-o', '-q', archive, entry, '-d', tmpDir], { stdio: 'pipe' });
  }
  const extracted = path.join(tmpDir, entry);
  if (!existsSync(extracted)) throw new Error(`[ffmpeg] ${entry} is not in ${path.basename(archive)}`);
  rmSync(outFile, { force: true });
  renameSync(extracted, outFile);
  rmSync(tmpDir, { recursive: true, force: true });
  if (process.platform !== 'win32') chmodSync(outFile, 0o755);
}

/**
 * Run the binary and check the encoders export needs. Returns false when this
 * machine cannot run that platform/arch at all (a cross-arch package): the
 * SHA-256 pin already proves the bytes, so that is not a failure.
 */
function verifyRuns(bin, platform, arch) {
  if (platform !== process.platform) return false;
  let out;
  try {
    out = execFileSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    // An x64 binary on an arm64 Mac without Rosetta: cannot judge it here.
    if (arch !== process.arch && /EBADARCH|bad CPU type/i.test(String(err.message))) return false;
    throw new Error(`[ffmpeg] the ${platform}-${arch} ffmpeg does not run: ${err.message}`);
  }
  const have = new Set(out.split('\n').map((l) => l.trim().split(/\s+/)[1]).filter(Boolean));
  const missing = MANIFEST.requiredEncoders.filter((e) => !have.has(e));
  if (missing.length) throw new Error(`[ffmpeg] the pinned ${platform}-${arch} ffmpeg lacks encoders export needs: ${missing.join(', ')}`);
  return true;
}

/** The cached, verified executable for one platform + arch (downloading on first use). */
async function ensureFfmpeg(platform, arch, root = ROOT) {
  const build = buildFor(platform, arch);
  const cacheDir = path.join(root, 'build', '.cache', 'ffmpeg');
  const bin = path.join(cacheDir, build.key, exeName(platform));
  const stamp = `${bin}.${build.sha256.slice(0, 16)}`;
  if (!existsSync(bin) || !existsSync(stamp)) {
    const archive = await ensureArchive(build, cacheDir);
    mkdirSync(path.dirname(bin), { recursive: true });
    extractEntry(archive, build.entry, bin);
    writeFileSync(stamp, build.sha256);  // which pin this binary came from: a bumped pin re-extracts
  }
  const ran = verifyRuns(bin, platform, arch);
  console.log(`[ffmpeg] ${build.key}: ffmpeg ${MANIFEST.version} ready (${(statSync(bin).size / 1e6).toFixed(0)} MB${ran ? ', encoders checked' : ', cross-arch: hash-verified only'})`);
  return bin;
}

class FfmpegMissingError extends Error {}

/** electron-builder `beforePack` half: stage ffmpeg for the platform + arch being packaged into build/ffmpeg/. */
async function stageFfmpeg(platform = process.platform, arch = process.arch, env = process.env, root = ROOT) {
  const a = archName(arch);
  const OUT = path.join(root, 'build', 'ffmpeg');
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const out = path.join(OUT, exeName(platform));
  try {
    if (platform === 'darwin' && a === 'universal') {
      const arm = await ensureFfmpeg(platform, 'arm64', root);
      const x64 = await ensureFfmpeg(platform, 'x64', root);
      execFileSync('lipo', ['-create', arm, x64, '-output', out]);
    } else {
      copyFileSync(await ensureFfmpeg(platform, a, root), out);
    }
  } catch (err) {
    const ci = (Boolean(env.CI) && env.CI !== 'false') || Boolean(env.GITHUB_ACTIONS);
    if (env.PREMATION_PACKAGE_WITHOUT_FFMPEG === '1' && !ci) {
      console.warn(`${err.message}\n[ffmpeg] PREMATION_PACKAGE_WITHOUT_FFMPEG=1: packaging WITHOUT ffmpeg — export will offer the in-app repair download.`);
      return [];
    }
    throw new FfmpegMissingError(err.message);
  }
  if (platform !== 'win32') chmodSync(out, 0o755);
  for (const f of ['LICENSE.txt', 'NOTICE.txt']) copyFileSync(path.join(root, 'resources', 'ffmpeg', f), path.join(OUT, f));
  console.log(`[ffmpeg] ${platform}/${a}: staged ${exeName(platform)} → build/ffmpeg`);
  return [exeName(platform), 'LICENSE.txt', 'NOTICE.txt'];
}

module.exports = { stageFfmpeg, ensureFfmpeg, buildFor, FfmpegMissingError };

if (require.main === module) {
  const args = process.argv.slice(2);
  const targets = args[0] === '--all'
    ? Object.keys(MANIFEST.builds).map((k) => k.split('-'))
    : [[args[0] || process.platform, args[1] || process.arch]];
  (async () => {
    for (const [p, a] of targets) await ensureFfmpeg(p, a);
  })().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
