/**
 * The ML model installer: one path for every model in models.json.
 *
 *   download (modelDownload.ts: https only, no credentials, size-capped)
 *     → verify (SHA-256 against the manifest's pin when it has one; always an
 *       ONNX protobuf, never an HTML error page)
 *     → write each file to a temp name and rename it into place
 *     → the metadata (model.json) last, so a crash mid-install reads as "not
 *       installed" and the engine never loads a half-written model.
 *
 * Every model's files are downloaded and verified BEFORE any is written: a
 * failure on the second file leaves the folder as it was.
 *
 * The per-model modules (objectMatteModel.ts, faceModel.ts, depthModel.ts,
 * handModel.ts) are thin adapters over this one, kept for their callers and
 * tests; the IPC channels they used to register are registered here, under
 * the same names, by `registerModelsIpc`. A generic `models:*` family on top
 * serves Settings ▸ Models.
 *
 * The metadata file keeps its historical name, `model.json`: installs already
 * on people's disks are read, not orphaned (their older shapes are accepted
 * in `readModelInstall`).
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { type IpcMainInvokeEvent } from 'electron';
import { handle } from './ipcGuard';
import { checkModelUrl, downloadModelBytes, registerDownloadCancel, type ModelDownloadProgress } from './modelDownload';
import {
  MODELS, bundledModelDir, manifestBytes, modelById, modelUserDir, type AppPaths, type ManifestModel, type ModelId,
} from './modelManifest';

export const META_FILE = 'model.json';

/** One file to fetch: the manifest's entry, with the URL resolved. */
export interface FileSpec {
  name: string;
  url: string;
  /** Verified when present; null means no checksum is known. */
  sha256: string | null;
  /** The expected size (progress totals), when known. */
  bytes: number | null;
}

/** What is on disk for a model, whichever metadata shape wrote it. */
export interface ModelInstall {
  /** The sources, in file order ('' when an older install did not record one). */
  urls: string[];
  /** The verified checksums, in file order ('' when none was checked). */
  sha256: string[];
  /** All files together. */
  bytes: number;
  installedAt: number;
  /** True for the copy shipped with the app (no metadata needed, cannot be removed). */
  bundled: boolean;
}

export type ModelInstallResult = { ok: true; model: ModelInstall } | { ok: false; message: string };

/** ONNX files are protobuf: field 1 (ir_version) as a varint, tag 0x08. An HTML error page is not. */
export function looksLikeOnnx(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 16) return false;
  const head = Buffer.from(bytes.subarray(0, 16)).toString('latin1').toLowerCase();
  if (head.includes('<!doctype') || head.includes('<html')) return false;
  return bytes[0] === 0x08;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeAtomic(file: string, bytes: Uint8Array | string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, file);
}

/** The metadata this installer writes. */
interface MetaV2 {
  files: Array<{ name: string; url: string; sha256: string | null }>;
  bytes: number;
  installedAt: number;
}

/** The shapes the four earlier installers wrote, read but never written again. */
interface MetaLegacy {
  url?: unknown;
  urls?: unknown;
  encoderUrl?: unknown;
  decoderUrl?: unknown;
  sha256?: unknown;
  installedAt?: unknown;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function parseMeta(raw: string, fileNames: readonly string[]): { urls: string[]; sha256: string[]; installedAt: number } {
  const meta = JSON.parse(raw) as Partial<MetaV2> & MetaLegacy;
  const installedAt = typeof meta.installedAt === 'number' ? meta.installedAt : 0;
  if (Array.isArray(meta.files)) {
    const byName = new Map<string, { url: string; sha256: string }>();
    for (const f of meta.files as Array<Partial<MetaV2['files'][number]>>) {
      if (typeof f?.name === 'string') byName.set(f.name, { url: str(f.url), sha256: str(f.sha256) });
    }
    return {
      urls: fileNames.map((n) => byName.get(n)?.url ?? ''),
      sha256: fileNames.map((n) => byName.get(n)?.sha256 ?? ''),
      installedAt,
    };
  }
  const urls: string[] = Array.isArray(meta.urls)
    ? (meta.urls as unknown[]).map(str)
    : typeof meta.encoderUrl === 'string' || typeof meta.decoderUrl === 'string'
      ? [str(meta.encoderUrl), str(meta.decoderUrl)]
      : [str(meta.url)];
  const sha = [str(meta.sha256)];
  return {
    urls: fileNames.map((_, i) => urls[i] ?? ''),
    sha256: fileNames.map((_, i) => sha[i] ?? ''),
    installedAt,
  };
}

/**
 * The install in `dir`, or null unless EVERY file is there (a half install is
 * no install). The user's folder needs its metadata too; a bundled copy
 * (`bundled: true`) is complete on its files alone.
 */
export async function readModelInstall(dir: string, fileNames: readonly string[], bundled = false): Promise<ModelInstall | null> {
  try {
    let bytes = 0;
    for (const name of fileNames) {
      const s = await stat(path.join(dir, name));
      if (!s.isFile()) return null;
      bytes += s.size;
    }
    let meta = { urls: fileNames.map(() => ''), sha256: fileNames.map(() => ''), installedAt: 0 };
    try {
      meta = parseMeta(await readFile(path.join(dir, META_FILE), 'utf8'), fileNames);
    } catch {
      if (!bundled) return null;
    }
    return { ...meta, bytes, bundled };
  } catch {
    return null;
  }
}

/**
 * Download every file, verify, then put them all in place.
 *
 * `labels` name the files in refusals ("The encoder URL: …"); the default is
 * "model". Progress is one envelope over all files: the total is the sum of
 * the manifest's sizes when every one is known, else the sum of the hosts'
 * Content-Lengths once every one has answered, else null.
 */
export async function installModelFiles(
  dir: string,
  files: readonly FileSpec[],
  signal: AbortSignal,
  emit: (receivedBytes: number, totalBytes: number | null) => void,
  labels: readonly string[] = [],
): Promise<ModelInstallResult> {
  const label = (i: number): string => labels[i] ?? 'model';
  for (const [i, f] of files.entries()) {
    const refusal = checkModelUrl(f.url);
    if (refusal) return { ok: false, message: `The ${label(i)} URL: ${refusal}` };
  }
  const pinnedTotal = files.every((f) => f.bytes !== null) ? files.reduce((s, f) => s + (f.bytes ?? 0), 0) : null;
  const headerTotals: Array<number | null> = files.map(() => null);
  const total = (): number | null => {
    if (pinnedTotal !== null) return pinnedTotal;
    let sum = 0;
    for (const t of headerTotals) {
      if (t === null) return null;
      sum += t;
    }
    return sum;
  };
  const got: Uint8Array[] = [];
  let before = 0;
  for (const [i, f] of files.entries()) {
    const res = await downloadModelBytes(f.url, signal, (received, t) => {
      headerTotals[i] = t;
      emit(before + received, total());
    });
    if (!res.ok) return res;
    if (f.sha256 !== null && sha256Hex(res.bytes) !== f.sha256.toLowerCase()) {
      return { ok: false, message: 'The downloaded model does not match its pinned checksum — nothing was installed.' };
    }
    // A pinned side file (SAM 2's constants.json) is proved by its checksum; only .onnx must parse as one.
    if (f.name.toLowerCase().endsWith('.onnx') && !looksLikeOnnx(res.bytes)) {
      return { ok: false, message: `The ${label(i)} URL did not return an ONNX model — check it points at the .onnx file itself.` };
    }
    got.push(res.bytes);
    before += res.bytes.byteLength;
  }
  try {
    await mkdir(dir, { recursive: true });
    // The metadata goes first-removed and last-written: without it the folder
    // answers "not installed" to the status query while files land.
    await rm(path.join(dir, META_FILE), { force: true });
    for (const [i, f] of files.entries()) await writeAtomic(path.join(dir, f.name), got[i]!);
    const installedAt = Date.now();
    const meta: MetaV2 = { files: files.map((f) => ({ name: f.name, url: f.url, sha256: f.sha256 })), bytes: before, installedAt };
    await writeAtomic(path.join(dir, META_FILE), JSON.stringify(meta));
    return {
      ok: true,
      model: { urls: files.map((f) => f.url), sha256: files.map((f) => f.sha256 ?? ''), bytes: before, installedAt, bundled: false },
    };
  } catch (err) {
    return { ok: false, message: `Could not save the model: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Remove the user's install; the engine goes back to the bundled copy, if any. */
export async function removeModel(dir: string, fileNames: readonly string[]): Promise<void> {
  await rm(path.join(dir, META_FILE), { force: true });
  for (const name of fileNames) await rm(path.join(dir, name), { force: true });
}

// ── The manifest-driven layer ────────────────────────────────────────────────

/** The file specs for `model`: the manifest's pins, or the request's URLs for a `user` model. */
export function fileSpecsFor(model: ManifestModel, urls: readonly string[] = []): { ok: true; files: FileSpec[] } | { ok: false; message: string } {
  const files: FileSpec[] = [];
  for (const [i, f] of model.files.entries()) {
    const url = model.source === 'pinned' ? f.url : urls[i] ?? f.url;
    if (typeof url !== 'string' || !url.trim()) {
      return {
        ok: false,
        message: model.source === 'pinned'
          ? 'This model download is not enabled in this build yet.'
          : model.files.length > 1 ? 'Both model URLs are required.' : 'The model URL is required.',
      };
    }
    files.push({ name: f.name, url: url.trim(), sha256: model.source === 'pinned' ? f.sha256 : null, bytes: model.source === 'pinned' ? f.bytes : null });
  }
  return { ok: true, files };
}

/** "encoder" / "decoder" for a pair, else nothing special. */
function labelsFor(model: ManifestModel): string[] {
  return model.id === 'object-matte' ? ['encoder', 'decoder'] : [];
}

export interface ModelDirs {
  userData: () => string;
  /** The app's paths, for the bundled copies; absent in tests. */
  app?: AppPaths;
}

/**
 * The user's install for `model`, else (when `includeBundled`) its bundled
 * copy, else null. The per-model status channels include the bundled copy
 * only for a `pinned` model: there "installed" means "the engine has it"
 * (hand tracking works out of the box), whereas for a `user` model such as
 * Object Matte the status has always meant "a custom model is installed OVER
 * the bundled one", and Remove goes back to the bundle, not to nothing.
 */
export async function readModelStatus(model: ManifestModel, dirs: ModelDirs, includeBundled = true): Promise<ModelInstall | null> {
  const names = model.files.map((f) => f.name);
  const user = await readModelInstall(modelUserDir(dirs.userData(), model.id), names);
  if (user) return user;
  if (includeBundled && model.bundled && dirs.app) return readModelInstall(bundledModelDir(dirs.app, model.id), names, true);
  return null;
}

/**
 * The status payload the renderer has always received for `model.ipc`
 * (`url` / `urls` / `encoderUrl` + `decoderUrl` / `sha256`), plus `bundled`.
 */
export function statusPayload(model: ManifestModel, install: ModelInstall): Record<string, unknown> {
  const base = { urls: install.urls, bytes: install.bytes, installedAt: install.installedAt, bundled: install.bundled };
  if (model.id === 'object-matte') return { ...base, encoderUrl: install.urls[0] ?? '', decoderUrl: install.urls[1] ?? '' };
  if (model.files.length === 1) return { ...base, url: install.urls[0] ?? '', sha256: install.sha256[0] ?? '' };
  return base;
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;

/** The URLs an install request carries, in file order, under any of the names the renderer has used. */
function requestUrls(request: Record<string, unknown>): string[] {
  if (Array.isArray(request.urls)) return (request.urls as unknown[]).map(str);
  if (typeof request.encoderUrl === 'string' || typeof request.decoderUrl === 'string') return [str(request.encoderUrl), str(request.decoderUrl)];
  if (typeof request.url === 'string') return [request.url];
  return [];
}

/** One install through IPC: the request checked, the download cancellable, progress on `progressChannel`. */
async function installThroughIpc(
  event: IpcMainInvokeEvent,
  model: ManifestModel,
  dirs: ModelDirs,
  request: unknown,
  progressChannel: string,
): Promise<{ ok: true; model: Record<string, unknown> } | { ok: false; message: string }> {
  const req = (request ?? {}) as Record<string, unknown>;
  const specs = fileSpecsFor(model, requestUrls(req));
  if (!specs.ok) return specs;
  const requestId = req.requestId;
  if (typeof requestId !== 'string' || !SAFE_REQUEST_ID.test(requestId)) return { ok: false, message: 'Bad install request.' };
  const cancel = registerDownloadCancel(requestId);
  if (!cancel) return { ok: false, message: 'That download is already running.' };
  const sender = event.sender;
  try {
    const res = await installModelFiles(modelUserDir(dirs.userData(), model.id), specs.files, cancel.signal, (receivedBytes, totalBytes) => {
      if (!sender.isDestroyed()) {
        sender.send(progressChannel, { requestId, receivedBytes, totalBytes, id: model.id } satisfies ModelDownloadProgress & { id: ModelId });
      }
    }, labelsFor(model));
    return res.ok ? { ok: true, model: statusPayload(model, res.model) } : res;
  } finally {
    cancel.done();
  }
}

/** What Settings ▸ Models lists. */
export interface ModelListing {
  id: ModelId;
  name: string;
  description: string;
  licence: string;
  bundled: boolean;
  source: 'pinned' | 'user';
  /** The download's size from the manifest, when every file's is known. */
  bytes: number | null;
  /** The user's install (`installed`), the shipped copy (`bundled`), or nothing. */
  state: 'installed' | 'bundled' | 'absent';
  installedBytes: number;
  installedAt: number;
  urls: string[];
}

export async function listModels(dirs: ModelDirs): Promise<ModelListing[]> {
  const out: ModelListing[] = [];
  for (const m of MODELS) {
    const install = await readModelStatus(m, dirs);
    out.push({
      id: m.id,
      name: m.name,
      description: m.description,
      licence: m.licence,
      bundled: m.bundled,
      source: m.source,
      bytes: manifestBytes(m),
      state: install ? (install.bundled ? 'bundled' : 'installed') : 'absent',
      installedBytes: install?.bytes ?? 0,
      installedAt: install?.installedAt ?? 0,
      urls: install?.urls ?? [],
    });
  }
  return out;
}

/**
 * Every model's channels, under the names the renderer has always used
 * (`objectMatte:*`, `faceModel:*`, `depthModel:*`, `handModel:*`), and the
 * generic `models:*` family keyed by id. The cancel channel stays
 * `objectMatte:cancelDownload` (modelDownload.ts) — one id space for all.
 */
export function registerModelsIpc(dirs: ModelDirs): void {
  for (const model of MODELS) {
    handle(`${model.ipc}:status`, async (): Promise<Record<string, unknown> | null> => {
      const install = await readModelStatus(model, dirs, model.source === 'pinned');
      return install ? statusPayload(model, install) : null;
    });
    handle(`${model.ipc}:remove`, async (): Promise<boolean> => {
      await removeModel(modelUserDir(dirs.userData(), model.id), model.files.map((f) => f.name));
      return true;
    });
    handle(`${model.ipc}:install`, (event: IpcMainInvokeEvent, request: unknown) => installThroughIpc(event, model, dirs, request, `${model.ipc}:downloadProgress`));
  }
  handle('models:list', async (): Promise<ModelListing[]> => listModels(dirs));
  handle('models:remove', async (_event, id: unknown): Promise<boolean> => {
    const model = MODELS.find((m) => m.id === id);
    if (!model) return false;
    await removeModel(modelUserDir(dirs.userData(), model.id), model.files.map((f) => f.name));
    return true;
  });
  handle('models:install', (event: IpcMainInvokeEvent, request: unknown) => {
    const id = (request as { id?: unknown } | null)?.id;
    const model = MODELS.find((m) => m.id === id);
    if (!model) return Promise.resolve({ ok: false as const, message: 'Unknown model.' });
    return installThroughIpc(event, model, dirs, request, 'models:downloadProgress');
  });
}

export { modelById, modelUserDir, MODELS };
export type { ManifestModel, ModelId };
