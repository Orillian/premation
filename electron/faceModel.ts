/**
 * The face landmark model for Face Tracking (models.json `face-landmarks`):
 * `face_landmark.onnx` in `<userData>/models/face-landmarks/`
 * (PREMATION_FACE_USER_DIR, engineHost.ts), downloaded on first use from a
 * URL the person supplies — no pinned source is known with certainty, so no
 * checksum is claimed (the manifest says `sha256: null`).
 *
 * A thin adapter over modelInstaller.ts, kept for its callers and tests; the
 * IPC channels (`faceModel:*`) are registered by `registerModelsIpc`.
 */

import * as path from 'node:path';
import { installModelFiles, readModelInstall, removeModel, type ModelInstall } from './modelInstaller';

export const FACE_MODEL_FILE = 'face_landmark.onnx';
const FILES = [FACE_MODEL_FILE] as const;

export interface FaceModelInstall {
  url: string;
  bytes: number;
  installedAt: number;
}

export type FaceModelInstallResult = { ok: true; model: FaceModelInstall } | { ok: false; message: string };

const shape = (m: ModelInstall): FaceModelInstall => ({ url: m.urls[0] ?? '', bytes: m.bytes, installedAt: m.installedAt });

export function faceModelUserDir(userData: string): string {
  return path.join(userData, 'models', 'face-landmarks');
}

export async function readFaceModelInstall(dir: string): Promise<FaceModelInstall | null> {
  const m = await readModelInstall(dir, FILES);
  return m ? shape(m) : null;
}

export async function installFaceModel(
  dir: string,
  url: string,
  signal: AbortSignal,
  emit: (receivedBytes: number, totalBytes: number | null) => void,
): Promise<FaceModelInstallResult> {
  const res = await installModelFiles(dir, [{ name: FACE_MODEL_FILE, url, sha256: null, bytes: null }], signal, emit);
  return res.ok ? { ok: true, model: shape(res.model) } : res;
}

export async function removeFaceModel(dir: string): Promise<void> {
  await removeModel(dir, FILES);
}
