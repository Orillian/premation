/**
 * The depth model for Make 3D from Photo / Video (camera program D3): Depth
 * Anything V2 Small (ONNX, Apache-2.0), installed on disk for the engine —
 * downloaded on first use, never shipped in the installer (the face model's
 * rule, faceModel.ts).
 *
 * The engine's depthEstimate job reads `depth_anything_v2_small.onnx` from
 * `<userData>/models/depth-anything/`, passed as `PREMATION_DEPTH_USER_DIR`
 * (engineHost.ts). Unlike the face model the source is PINNED: one URL and the
 * SHA-256 of its bytes; anything else is refused.
 *
 * Approved by the owner 2026-10-14: the pin below is an exact Hugging Face
 * revision of onnx-community/depth-anything-v2-small (Apache-2.0); a file whose
 * SHA-256 differs is refused and nothing is installed.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { type IpcMainInvokeEvent } from 'electron';
import { handle } from './ipcGuard';
import { checkModelUrl, downloadModelBytes, registerDownloadCancel, type ModelDownloadProgress } from './modelDownload';
import { looksLikeOnnx } from './objectMatteModel';

export const DEPTH_MODEL_FILE = 'depth_anything_v2_small.onnx';
const META_FILE = 'model.json';

/** The pinned download: onnx-community/depth-anything-v2-small at an exact revision (fp32, 99,060,839 bytes). */
export const DEPTH_MODEL_URL =
  'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model.onnx';
/** SHA-256 (hex, lower case) of the file at DEPTH_MODEL_URL. */
export const DEPTH_MODEL_SHA256 = 'afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c';

export interface DepthModelInstall {
  url: string;
  sha256: string;
  bytes: number;
  installedAt: number;
}

export type DepthModelInstallResult = { ok: true; model: DepthModelInstall } | { ok: false; message: string };

export function depthModelUserDir(userData: string): string {
  return path.join(userData, 'models', 'depth-anything');
}

export async function readDepthModelInstall(dir: string): Promise<DepthModelInstall | null> {
  try {
    const s = await stat(path.join(dir, DEPTH_MODEL_FILE));
    if (!s.isFile()) return null;
    const meta = JSON.parse(await readFile(path.join(dir, META_FILE), 'utf8')) as Partial<DepthModelInstall>;
    return {
      url: typeof meta.url === 'string' ? meta.url : '',
      sha256: typeof meta.sha256 === 'string' ? meta.sha256 : '',
      bytes: s.size,
      installedAt: typeof meta.installedAt === 'number' ? meta.installedAt : 0,
    };
  } catch {
    return null;
  }
}

async function writeAtomic(file: string, bytes: Uint8Array | string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, file);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Download the pinned model (`pin` overrides the constants — tests). */
export async function installDepthModel(
  dir: string,
  signal: AbortSignal,
  emit: (receivedBytes: number, totalBytes: number | null) => void,
  pin: { url: string; sha256: string } = { url: DEPTH_MODEL_URL, sha256: DEPTH_MODEL_SHA256 },
): Promise<DepthModelInstallResult> {
  if (!pin.url || !pin.sha256) {
    return { ok: false, message: 'The depth model download is not enabled in this build yet — use a depth-map layer instead.' };
  }
  const refusal = checkModelUrl(pin.url);
  if (refusal) return { ok: false, message: `The model URL: ${refusal}` };
  const got = await downloadModelBytes(pin.url, signal, emit);
  if (!got.ok) return got;
  const sum = sha256Hex(got.bytes);
  if (sum !== pin.sha256.toLowerCase()) return { ok: false, message: 'The downloaded model does not match its pinned checksum — nothing was installed.' };
  if (!looksLikeOnnx(got.bytes)) return { ok: false, message: 'The download is not an ONNX model.' };
  try {
    await mkdir(dir, { recursive: true });
    await rm(path.join(dir, META_FILE), { force: true });
    await writeAtomic(path.join(dir, DEPTH_MODEL_FILE), got.bytes);
    const model: DepthModelInstall = { url: pin.url, sha256: sum, bytes: got.bytes.byteLength, installedAt: Date.now() };
    await writeAtomic(path.join(dir, META_FILE), JSON.stringify(model));
    return { ok: true, model };
  } catch (err) {
    return { ok: false, message: `Could not save the model: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function removeDepthModel(dir: string): Promise<void> {
  await rm(path.join(dir, META_FILE), { force: true });
  await rm(path.join(dir, DEPTH_MODEL_FILE), { force: true });
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;

export function registerDepthModelIpc(userData: () => string): void {
  const dir = (): string => depthModelUserDir(userData());
  handle('depthModel:status', async (): Promise<DepthModelInstall | null> => readDepthModelInstall(dir()));
  handle('depthModel:remove', async (): Promise<boolean> => {
    await removeDepthModel(dir());
    return true;
  });
  handle('depthModel:install', async (event: IpcMainInvokeEvent, request: unknown): Promise<DepthModelInstallResult> => {
    const { requestId } = (request ?? {}) as { requestId?: unknown };
    if (typeof requestId !== 'string' || !SAFE_REQUEST_ID.test(requestId)) return { ok: false, message: 'Bad install request.' };
    const cancel = registerDownloadCancel(requestId);
    if (!cancel) return { ok: false, message: 'That download is already running.' };
    const sender = event.sender;
    try {
      return await installDepthModel(dir(), cancel.signal, (receivedBytes, totalBytes) => {
        if (!sender.isDestroyed()) sender.send('depthModel:downloadProgress', { requestId, receivedBytes, totalBytes } satisfies ModelDownloadProgress);
      });
    } finally {
      cancel.done();
    }
  });
}
