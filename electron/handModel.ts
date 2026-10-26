/**
 * The hand models for live performance input (docs/PERFORMANCE_ANIMATION_PLAN.md
 * P1): MediaPipe's palm detector and hand landmarker, OpenCV Zoo's ONNX
 * exports (Apache-2.0) — downloaded on first use, never shipped in the
 * installer (the face model's rule, faceModel.ts).
 *
 * The engine's live-input child reads `palm_detection.onnx` and
 * `hand_landmark.onnx` from `<userData>/models/hand-landmarks/`, passed as
 * `PREMATION_HAND_USER_DIR` (engineHost.ts). Like the depth model the source
 * is PINNED (depthModel.ts): an exact Hugging Face revision per file and the
 * SHA-256 of its bytes; anything else is refused and nothing is installed.
 *
 * Approved by the owner 2026-10-23 (these two files, from these repositories).
 * The checksums are the LFS object ids of the pinned revisions, and match the
 * files the P1.0 latency spike measured.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { type IpcMainInvokeEvent } from 'electron';
import { handle } from './ipcGuard';
import { checkModelUrl, downloadModelBytes, registerDownloadCancel, type ModelDownloadProgress } from './modelDownload';
import { looksLikeOnnx } from './objectMatteModel';
import { sha256Hex } from './depthModel';

export const PALM_MODEL_FILE = 'palm_detection.onnx';
export const HAND_MODEL_FILE = 'hand_landmark.onnx';
const META_FILE = 'model.json';

export interface PinnedFile {
  file: string;
  url: string;
  sha256: string;
  bytes: number;
}

/** The pinned downloads: opencv/palm_detection_mediapipe and opencv/handpose_estimation_mediapipe (fp32). */
export const HAND_MODEL_PINS: readonly PinnedFile[] = [
  {
    file: PALM_MODEL_FILE,
    url: 'https://huggingface.co/opencv/palm_detection_mediapipe/resolve/233e619dcea1759bf6de707b9b904fe30881ea55/palm_detection_mediapipe_2023feb.onnx',
    sha256: '78ff51c38496b7fc8b8ebdb6cc8c1abb02fa6c38427c6848254cdaba57fcce7c',
    bytes: 3_905_734,
  },
  {
    file: HAND_MODEL_FILE,
    url: 'https://huggingface.co/opencv/handpose_estimation_mediapipe/resolve/4b2a0b446e5cf2f11fb6b2c7251091c035d2c1f7/handpose_estimation_mediapipe_2023feb.onnx',
    sha256: 'db0898ae717b76b075d9bf563af315b29562e11f8df5027a1ef07b02bef6d81c',
    bytes: 4_099_621,
  },
];

export interface HandModelInstall {
  /** The pinned sources, in file order. */
  urls: string[];
  /** Both files together. */
  bytes: number;
  installedAt: number;
}

export type HandModelInstallResult = { ok: true; model: HandModelInstall } | { ok: false; message: string };

export function handModelUserDir(userData: string): string {
  return path.join(userData, 'models', 'hand-landmarks');
}

/** The install, when BOTH files and the metadata are there (a half install is no install). */
export async function readHandModelInstall(dir: string): Promise<HandModelInstall | null> {
  try {
    let bytes = 0;
    for (const f of [PALM_MODEL_FILE, HAND_MODEL_FILE]) {
      const s = await stat(path.join(dir, f));
      if (!s.isFile()) return null;
      bytes += s.size;
    }
    const meta = JSON.parse(await readFile(path.join(dir, META_FILE), 'utf8')) as Partial<HandModelInstall>;
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

/**
 * Download both pinned files (`pins` overrides the constants — tests). Both
 * are downloaded and verified BEFORE either is written, so a failure on the
 * second leaves the folder as it was. Progress is over both files together.
 */
export async function installHandModel(
  dir: string,
  signal: AbortSignal,
  emit: (receivedBytes: number, totalBytes: number | null) => void,
  pins: readonly PinnedFile[] = HAND_MODEL_PINS,
): Promise<HandModelInstallResult> {
  const total = pins.reduce((s, p) => s + p.bytes, 0);
  const got: Array<{ pin: PinnedFile; bytes: Uint8Array }> = [];
  let before = 0;
  for (const pin of pins) {
    const refusal = checkModelUrl(pin.url);
    if (refusal) return { ok: false, message: `The model URL: ${refusal}` };
    const res = await downloadModelBytes(pin.url, signal, (received) => emit(before + received, total));
    if (!res.ok) return res;
    if (sha256Hex(res.bytes) !== pin.sha256.toLowerCase()) {
      return { ok: false, message: 'The downloaded hand model does not match its pinned checksum — nothing was installed.' };
    }
    if (!looksLikeOnnx(res.bytes)) return { ok: false, message: 'The download is not an ONNX model.' };
    got.push({ pin, bytes: res.bytes });
    before += res.bytes.byteLength;
  }
  try {
    await mkdir(dir, { recursive: true });
    // The metadata goes first and comes back last: an interrupted install reads as none.
    await rm(path.join(dir, META_FILE), { force: true });
    for (const g of got) await writeAtomic(path.join(dir, g.pin.file), g.bytes);
    const model: HandModelInstall = { urls: got.map((g) => g.pin.url), bytes: before, installedAt: Date.now() };
    await writeAtomic(path.join(dir, META_FILE), JSON.stringify(model));
    return { ok: true, model };
  } catch (err) {
    return { ok: false, message: `Could not save the hand model: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function removeHandModel(dir: string): Promise<void> {
  await rm(path.join(dir, META_FILE), { force: true });
  await rm(path.join(dir, PALM_MODEL_FILE), { force: true });
  await rm(path.join(dir, HAND_MODEL_FILE), { force: true });
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;

export function registerHandModelIpc(userData: () => string): void {
  const dir = (): string => handModelUserDir(userData());
  handle('handModel:status', async (): Promise<HandModelInstall | null> => readHandModelInstall(dir()));
  handle('handModel:remove', async (): Promise<boolean> => {
    await removeHandModel(dir());
    return true;
  });
  handle('handModel:install', async (event: IpcMainInvokeEvent, request: unknown): Promise<HandModelInstallResult> => {
    const { requestId } = (request ?? {}) as { requestId?: unknown };
    if (typeof requestId !== 'string' || !SAFE_REQUEST_ID.test(requestId)) return { ok: false, message: 'Bad install request.' };
    const cancel = registerDownloadCancel(requestId);
    if (!cancel) return { ok: false, message: 'That download is already running.' };
    const sender = event.sender;
    try {
      return await installHandModel(dir(), cancel.signal, (receivedBytes, totalBytes) => {
        if (!sender.isDestroyed()) sender.send('handModel:downloadProgress', { requestId, receivedBytes, totalBytes } satisfies ModelDownloadProgress);
      });
    } finally {
      cancel.done();
    }
  });
}
