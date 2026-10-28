/**
 * The hand models for live performance input (models.json `hand-landmarks`,
 * docs/PERFORMANCE_ANIMATION_PLAN.md P1): MediaPipe's palm detector and hand
 * landmarker, OpenCV Zoo's ONNX exports, `palm_detection.onnx` +
 * `hand_landmark.onnx`. Bundled with the app (<resources>/models/hand-landmarks,
 * PREMATION_HAND_DIR); an install here goes to `<userData>/models/hand-landmarks/`
 * (PREMATION_HAND_USER_DIR, engineHost.ts) for a build without the bundle.
 * Both files are PINNED in the manifest — an exact Hugging Face revision each
 * and the SHA-256 of its bytes (approved by the owner 2026-10-23).
 *
 * A thin adapter over modelInstaller.ts, kept for its callers and tests; the
 * IPC channels (`handModel:*`) are registered by `registerModelsIpc`.
 */

import * as path from 'node:path';
import { installModelFiles, readModelInstall, removeModel, type ModelInstall } from './modelInstaller';
import { modelById } from './modelManifest';

const MANIFEST = modelById('hand-landmarks');

export interface PinnedFile {
  file: string;
  url: string;
  sha256: string;
  bytes: number;
}

/** The pinned downloads: opencv/palm_detection_mediapipe and opencv/handpose_estimation_mediapipe (fp32). */
export const HAND_MODEL_PINS: readonly PinnedFile[] = MANIFEST.files.map((f) => ({
  file: f.name,
  url: f.url ?? '',
  sha256: f.sha256 ?? '',
  bytes: f.bytes ?? 0,
}));

export const PALM_MODEL_FILE = HAND_MODEL_PINS[0]!.file;
export const HAND_MODEL_FILE = HAND_MODEL_PINS[1]!.file;
const FILES = [PALM_MODEL_FILE, HAND_MODEL_FILE] as const;

export interface HandModelInstall {
  /** The pinned sources, in file order. */
  urls: string[];
  /** Both files together. */
  bytes: number;
  installedAt: number;
}

export type HandModelInstallResult = { ok: true; model: HandModelInstall } | { ok: false; message: string };

const shape = (m: ModelInstall): HandModelInstall => ({ urls: m.urls, bytes: m.bytes, installedAt: m.installedAt });

export function handModelUserDir(userData: string): string {
  return path.join(userData, 'models', 'hand-landmarks');
}

/** The install, when BOTH files and the metadata are there (a half install is no install). */
export async function readHandModelInstall(dir: string): Promise<HandModelInstall | null> {
  const m = await readModelInstall(dir, FILES);
  return m ? shape(m) : null;
}

/**
 * Download both pinned files (`pins` overrides the manifest — tests). Both
 * are downloaded and verified BEFORE either is written, so a failure on the
 * second leaves the folder as it was. Progress is over both files together.
 */
export async function installHandModel(
  dir: string,
  signal: AbortSignal,
  emit: (receivedBytes: number, totalBytes: number | null) => void,
  pins: readonly PinnedFile[] = HAND_MODEL_PINS,
): Promise<HandModelInstallResult> {
  const res = await installModelFiles(
    dir,
    pins.map((p) => ({ name: p.file, url: p.url, sha256: p.sha256, bytes: p.bytes })),
    signal,
    emit,
  );
  return res.ok ? { ok: true, model: shape(res.model) } : res;
}

export async function removeHandModel(dir: string): Promise<void> {
  await removeModel(dir, FILES);
}
