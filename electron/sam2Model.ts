/**
 * The SAM 2.1 video model for Object Matte / Roto Brush walks (AE parity Step
 * 3.1, docs/AE_PARITY_PLAN.md): facebook/sam2.1-hiera-tiny with its memory
 * modules, the square-zero-labs/sam2.1-tiny-video-onnx export (Apache-2.0,
 * like the SAM 2 weights) — downloaded on first use, never shipped in the
 * installer (the face model's rule, faceModel.ts).
 *
 * The engine's objectMatte walk reads the five graphs and constants.json from
 * `<userData>/models/sam2-video/`, passed as `PREMATION_SAM2_USER_DIR`
 * (engineHost.ts); with all six files there it tracks with SAM 2's memory
 * bank instead of SlimSAM per frame. Like the depth and hand models the source
 * is PINNED (depthModel.ts): one exact Hugging Face revision and the SHA-256
 * of every file; anything else is refused and nothing is installed.
 *
 * NOT YET APPROVED by the owner (the depth / hand pins were): proposed
 * 2026-10-28 with this revision. The checksums are the LFS object ids of the
 * revision (constants.json's is the file's own SHA-256), checked against the
 * downloaded bytes.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { type IpcMainInvokeEvent } from 'electron';
import { handle } from './ipcGuard';
import { checkModelUrl, downloadModelBytes, registerDownloadCancel, type ModelDownloadProgress } from './modelDownload';
import { looksLikeOnnx } from './objectMatteModel';
import { sha256Hex } from './depthModel';
import { type PinnedFile } from './handModel';

const META_FILE = 'model.json';
const REVISION = 'https://huggingface.co/square-zero-labs/sam2.1-tiny-video-onnx/resolve/3b2984dd865f6e9d2cc6aed0be6a5a5c2eb352ce';

/** The pinned downloads, in the order they are fetched (190,082,794 bytes together). */
export const SAM2_MODEL_PINS: readonly PinnedFile[] = [
  { file: 'constants.json', url: `${REVISION}/constants.json`, sha256: '172edc70e892aab0aef6caedf97b8e4091fbf6c5d26dac5fd9ea69d093d927d3', bytes: 9_922 },
  { file: 'pointer_tpos.onnx', url: `${REVISION}/onnx/pointer_tpos.onnx`, sha256: '7e71df1d75dba09bc18dd4ae745c2a2cceebdd14d84eadea2fe65d0205f101fc', bytes: 67_289 },
  { file: 'memory_encoder.onnx', url: `${REVISION}/onnx/memory_encoder.onnx`, sha256: '580d246c109de88838f600ba7c1c0d03d1fe267f7641b06f8c88c5f0dc5834cd', bytes: 5_616_496 },
  { file: 'mask_decoder.onnx', url: `${REVISION}/onnx/mask_decoder.onnx`, sha256: '0461896de3db00936fe1643506f129d71cb6d5d2ae15754811756b7ea1b070c6', bytes: 17_794_355 },
  { file: 'memory_attention.onnx', url: `${REVISION}/onnx/memory_attention.onnx`, sha256: '791e648ce8f5ef91ad00ba06e83066ff261ae5a645f0b042b4f46a89fd054baf', bytes: 32_259_165 },
  { file: 'vision_encoder.onnx', url: `${REVISION}/onnx/vision_encoder.onnx`, sha256: 'aa7a8542942f042e235a993a1ab0ccf5f049918500577802a7f10ec1b39bb873', bytes: 134_335_567 },
];

export interface Sam2ModelInstall {
  urls: string[];
  bytes: number;
  installedAt: number;
}

export type Sam2ModelInstallResult = { ok: true; model: Sam2ModelInstall } | { ok: false; message: string };

export function sam2ModelUserDir(userData: string): string {
  return path.join(userData, 'models', 'sam2-video');
}

/** The install, when EVERY file and the metadata are there (a half install is no install). */
export async function readSam2ModelInstall(dir: string, pins: readonly PinnedFile[] = SAM2_MODEL_PINS): Promise<Sam2ModelInstall | null> {
  try {
    let bytes = 0;
    for (const p of pins) {
      const s = await stat(path.join(dir, p.file));
      if (!s.isFile()) return null;
      bytes += s.size;
    }
    const meta = JSON.parse(await readFile(path.join(dir, META_FILE), 'utf8')) as Partial<Sam2ModelInstall>;
    return {
      urls: Array.isArray(meta.urls) ? meta.urls.filter((u): u is string => typeof u === 'string') : [],
      bytes,
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

/** constants.json is JSON with the memory table the engine needs; the rest are ONNX. */
function looksRight(file: string, bytes: Uint8Array): boolean {
  if (!file.endsWith('.json')) return looksLikeOnnx(bytes);
  try {
    const j = JSON.parse(Buffer.from(bytes).toString('utf8')) as { memory_temporal_positional_encoding?: unknown };
    return Array.isArray(j.memory_temporal_positional_encoding);
  } catch {
    return false;
  }
}

/**
 * Download every pinned file (`pins` overrides the constants — tests), each
 * verified BEFORE any is written, so a failure leaves the folder as it was.
 * Progress is over all files together.
 */
export async function installSam2Model(
  dir: string,
  signal: AbortSignal,
  emit: (receivedBytes: number, totalBytes: number | null) => void,
  pins: readonly PinnedFile[] = SAM2_MODEL_PINS,
): Promise<Sam2ModelInstallResult> {
  const total = pins.reduce((s, p) => s + p.bytes, 0);
  const got: Array<{ pin: PinnedFile; bytes: Uint8Array }> = [];
  let before = 0;
  for (const pin of pins) {
    const refusal = checkModelUrl(pin.url);
    if (refusal) return { ok: false, message: `The model URL: ${refusal}` };
    const res = await downloadModelBytes(pin.url, signal, (received) => emit(before + received, total));
    if (!res.ok) return res;
    if (sha256Hex(res.bytes) !== pin.sha256.toLowerCase()) {
      return { ok: false, message: 'The downloaded SAM 2 model does not match its pinned checksum — nothing was installed.' };
    }
    if (!looksRight(pin.file, res.bytes)) return { ok: false, message: `The download of ${pin.file} is not what the SAM 2 model needs.` };
    got.push({ pin, bytes: res.bytes });
    before += res.bytes.byteLength;
  }
  try {
    await mkdir(dir, { recursive: true });
    // The metadata goes first and comes back last: an interrupted install reads as none.
    await rm(path.join(dir, META_FILE), { force: true });
    for (const g of got) await writeAtomic(path.join(dir, g.pin.file), g.bytes);
    const model: Sam2ModelInstall = { urls: got.map((g) => g.pin.url), bytes: before, installedAt: Date.now() };
    await writeAtomic(path.join(dir, META_FILE), JSON.stringify(model));
    return { ok: true, model };
  } catch (err) {
    return { ok: false, message: `Could not save the SAM 2 model: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Remove the model; the engine's walks go back to SlimSAM per frame. */
export async function removeSam2Model(dir: string, pins: readonly PinnedFile[] = SAM2_MODEL_PINS): Promise<void> {
  await rm(path.join(dir, META_FILE), { force: true });
  for (const p of pins) await rm(path.join(dir, p.file), { force: true });
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;

export function registerSam2ModelIpc(userData: () => string): void {
  const dir = (): string => sam2ModelUserDir(userData());
  handle('sam2Model:status', async (): Promise<Sam2ModelInstall | null> => readSam2ModelInstall(dir()));
  handle('sam2Model:remove', async (): Promise<boolean> => {
    await removeSam2Model(dir());
    return true;
  });
  handle('sam2Model:install', async (event: IpcMainInvokeEvent, request: unknown): Promise<Sam2ModelInstallResult> => {
    const { requestId } = (request ?? {}) as { requestId?: unknown };
    if (typeof requestId !== 'string' || !SAFE_REQUEST_ID.test(requestId)) return { ok: false, message: 'Bad install request.' };
    const cancel = registerDownloadCancel(requestId);
    if (!cancel) return { ok: false, message: 'That download is already running.' };
    const sender = event.sender;
    try {
      return await installSam2Model(dir(), cancel.signal, (receivedBytes, totalBytes) => {
        if (!sender.isDestroyed()) sender.send('sam2Model:downloadProgress', { requestId, receivedBytes, totalBytes } satisfies ModelDownloadProgress);
      });
    } finally {
      cancel.done();
    }
  });
}
