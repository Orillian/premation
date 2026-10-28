/**
 * Stage every BUNDLED ML model (electron/models.json, `bundled: true`) into
 * public/models/<id>/:
 *
 *   public/models/object-matte/     SlimSAM encoder + decoder (Apache-2.0, ~14 MB)
 *   public/models/hand-landmarks/   MediaPipe palm + hand landmarks (Apache-2.0, 7.6 MB)
 *
 * Vite copies public/ into dist/ verbatim and electron-builder ships each
 * folder as <resources>/models/<id> (extraResources), the folder Electron
 * hands the engine as PREMATION_<env>_DIR (electron/modelManifest.ts
 * bundledModelEnv). Everything here is idempotent: present-and-valid files are
 * left alone, so only the first run (or a manifest change) touches the
 * network. The directory is gitignored — weights do not belong in history.
 *
 * Validity is the manifest's word: a file with a `sha256` must hash to it,
 * both on disk and as downloaded; a file without one (the SAM pair today — no
 * checksum has been invented) must be an ONNX protobuf of at least `minBytes`.
 * Beside the files goes model.json, the same metadata an install writes, so
 * the app can say where the bundled copy came from.
 *
 * Runs as the first step of `electron:build` (packaging always bundles the
 * models, and a broken download fails the build loudly rather than shipping a
 * silently degraded app). Run it by hand — `npm run fetch:models` — to get the
 * neural paths in `npm run dev`.
 */

const { createHash } = require('node:crypto');
const { mkdirSync, statSync, readFileSync, renameSync, writeFileSync, unlinkSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MANIFEST = require(path.join(ROOT, 'electron', 'models.json'));
const MODELS_DIR = path.join(ROOT, 'public', 'models');
const META_FILE = 'model.json';

/** ONNX is protobuf; field 1 (ir_version) tags the first byte 0x08. An error
 *  page is HTML and fails this immediately. */
function looksLikeOnnx(bytes) {
  return bytes.length > 16 && bytes[0] === 0x08;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Why `bytes` are not the manifest's file, or null when they are. */
function problem(file, bytes) {
  if (file.sha256) {
    const sum = sha256(bytes);
    return sum === file.sha256.toLowerCase() ? null : `SHA-256 ${sum} is not the pinned ${file.sha256}`;
  }
  if (bytes.length < (file.minBytes ?? 16)) return `${bytes.length} bytes — too small to be the model`;
  return looksLikeOnnx(bytes) ? null : 'not an ONNX file';
}

function haveValid(dest, file) {
  try {
    if (!statSync(dest).isFile()) return false;
    return problem(file, readFileSync(dest)) === null;
  } catch {
    return false;
  }
}

/**
 * Statuses worth trying again.
 *
 * 429 is the one that actually bites: Hugging Face rate-limits by IP, and a
 * CI runner shares its IP with everything else on that host, so a release can
 * fail on the download having changed nothing. 5xx and 408 are the same kind
 * of "not your fault, try again" answer.
 *
 * A 404 is NOT here on purpose — a model that has moved should fail loudly on
 * the first attempt rather than after a minute of pointless retrying.
 */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const ATTEMPTS = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exponential with jitter: 2s, 4s, 8s, 16s, capped. Jitter matters because
 *  the files are fetched back to back and would otherwise retry in lockstep
 *  into the same rate limit. */
function backoff(attempt) {
  const base = Math.min(2000 * 2 ** (attempt - 1), 30_000);
  return base + Math.floor(Math.random() * 1000);
}

/**
 * One file, with retries on transient answers.
 *
 * Deliberately NOT softened into "give up and carry on": this script exists so
 * that a broken download fails the build rather than shipping a silently
 * degraded app (see the header). Retrying a 429 does not weaken that — it just
 * stops a transient rate-limit from being reported as a broken one.
 */
async function fetchBytes(url, tag) {
  let lastErr;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, { redirect: 'follow' });
    } catch (err) {
      // A dropped connection is as transient as a 503.
      lastErr = err;
      if (attempt === ATTEMPTS) break;
      const wait = backoff(attempt);
      console.log(`[${tag}] ${url} failed (${err.message}); retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    if (res.ok) return Buffer.from(await res.arrayBuffer());

    lastErr = new Error(`${url} answered ${res.status}`);
    if (!RETRYABLE.has(res.status) || attempt === ATTEMPTS) break;
    // Honour Retry-After when the server bothers to say; it knows better than
    // our backoff curve does.
    const after = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 60_000) : backoff(attempt);
    console.log(`[${tag}] ${url} answered ${res.status}; retrying in ${Math.round(wait / 1000)}s (attempt ${attempt}/${ATTEMPTS})`);
    await sleep(wait);
  }
  throw lastErr;
}

async function download(file, dest, tag) {
  const bytes = await fetchBytes(file.url, tag);
  const why = problem(file, bytes);
  if (why) throw new Error(`${file.url}: ${why}`);
  // Write-then-rename so an interrupted download never passes haveValid().
  const tmp = `${dest}.download`;
  writeFileSync(tmp, bytes);
  try {
    renameSync(tmp, dest);
  } catch (err) {
    unlinkSync(tmp);
    throw err;
  }
  return bytes.length;
}

async function stageModel(model) {
  const tag = model.id;
  const dir = path.join(MODELS_DIR, model.id);
  mkdirSync(dir, { recursive: true });
  let bytes = 0;
  for (const file of model.files) {
    if (!file.url) throw new Error(`${model.id}/${file.name} is bundled but has no URL in electron/models.json`);
    const dest = path.join(dir, file.name);
    if (haveValid(dest, file)) {
      bytes += statSync(dest).size;
      continue;
    }
    console.log(`[${tag}] downloading ${file.name} …`);
    const size = await download(file, dest, tag);
    bytes += size;
    console.log(`[${tag}] ${file.name} (${(size / 1e6).toFixed(1)} MB${file.sha256 ? ', checksum verified' : ''})`);
  }
  // The same shape electron/modelInstaller.ts writes; installedAt 0 marks a
  // copy that was never "installed" by the person.
  const meta = { files: model.files.map((f) => ({ name: f.name, url: f.url, sha256: f.sha256 })), bytes, installedAt: 0 };
  const metaTmp = path.join(dir, `${META_FILE}.download`);
  writeFileSync(metaTmp, JSON.stringify(meta));
  renameSync(metaTmp, path.join(dir, META_FILE));
}

async function main() {
  const bundled = MANIFEST.models.filter((m) => m.bundled);
  for (const model of bundled) await stageModel(model);
  console.log(`[models] bundled model assets ready (${bundled.map((m) => m.id).join(', ')})`);
}

main().catch((err) => {
  console.error(`[models] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
