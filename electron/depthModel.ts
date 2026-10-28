/**
 * The depth model for Make 3D from Photo / Video (models.json
 * `depth-anything`): Depth Anything V2 Small, `depth_anything_v2_small.onnx`
 * in `<userData>/models/depth-anything/` (PREMATION_DEPTH_USER_DIR,
 * engineHost.ts), downloaded on first use. The source is PINNED in the
 * manifest — one URL at an exact Hugging Face revision and the SHA-256 of its
 * bytes (approved by the owner 2026-10-14); anything else is refused.
 *
 * A thin adapter over modelInstaller.ts, kept for its callers and tests; the
 * IPC channels (`depthModel:*`) are registered by `registerModelsIpc`.
 */

import * as path from 'node:path';
import { installModelFiles, readModelInstall, removeModel, type ModelInstall } from './modelInstaller';
import { modelById } from './modelManifest';

export { sha256Hex } from './modelInstaller';

const MANIFEST = modelById('depth-anything');
const PIN = MANIFEST.files[0]!;

export const DEPTH_MODEL_FILE = PIN.name;
const FILES = [DEPTH_MODEL_FILE] as const;

/** The pinned download: onnx-community/depth-anything-v2-small at an exact revision (fp32, 99,060,839 bytes). */
export const DEPTH_MODEL_URL = PIN.url ?? '';
/** SHA-256 (hex, lower case) of the file at DEPTH_MODEL_URL. */
export const DEPTH_MODEL_SHA256 = PIN.sha256 ?? '';

export interface DepthModelInstall {
  url: string;
  sha256: string;
  bytes: number;
  installedAt: number;
}

export type DepthModelInstallResult = { ok: true; model: DepthModelInstall } | { ok: false; message: string };

const shape = (m: ModelInstall): DepthModelInstall => ({
  url: m.urls[0] ?? '',
  sha256: m.sha256[0] ?? '',
  bytes: m.bytes,
  installedAt: m.installedAt,
});

export function depthModelUserDir(userData: string): string {
  return path.join(userData, 'models', 'depth-anything');
}

export async function readDepthModelInstall(dir: string): Promise<DepthModelInstall | null> {
  const m = await readModelInstall(dir, FILES);
  return m ? shape(m) : null;
}

/** Download the pinned model (`pin` overrides the manifest — tests). */
export async function installDepthModel(
  dir: string,
  signal: AbortSignal,
  emit: (receivedBytes: number, totalBytes: number | null) => void,
  pin: { url: string; sha256: string } = { url: DEPTH_MODEL_URL, sha256: DEPTH_MODEL_SHA256 },
): Promise<DepthModelInstallResult> {
  if (!pin.url || !pin.sha256) {
    return { ok: false, message: 'The depth model download is not enabled in this build yet — use a depth-map layer instead.' };
  }
  const bytes = pin.url === DEPTH_MODEL_URL ? PIN.bytes : null;
  const res = await installModelFiles(dir, [{ name: DEPTH_MODEL_FILE, url: pin.url, sha256: pin.sha256, bytes }], signal, emit);
  return res.ok ? { ok: true, model: shape(res.model) } : res;
}

export async function removeDepthModel(dir: string): Promise<void> {
  await removeModel(dir, FILES);
}
