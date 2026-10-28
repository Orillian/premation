/**
 * The user's Object Matte model (models.json `object-matte`): a SAM-class
 * encoder / decoder pair installed over the bundled one, at
 * `<userData>/models/object-matte/` (PREMATION_SAM_USER_DIR, engineHost.ts).
 * The engine checks the folder on every job, so an install or a removal
 * applies to the next click; without it the engine uses the bundled pair.
 *
 * A thin adapter over modelInstaller.ts, kept for its callers and tests; the
 * IPC channels (`objectMatte:*`) are registered by `registerModelsIpc`.
 */

import * as path from 'node:path';
import { installModelFiles, readModelInstall, removeModel, type ModelInstall } from './modelInstaller';

export { looksLikeOnnx } from './modelInstaller';

export const ENCODER_FILE = 'vision_encoder_quantized.onnx';
export const DECODER_FILE = 'prompt_encoder_mask_decoder_quantized.onnx';
const FILES = [ENCODER_FILE, DECODER_FILE] as const;

export interface ObjectMatteInstall {
  encoderUrl: string;
  decoderUrl: string;
  bytes: number;
  installedAt: number;
}

export type ObjectMatteInstallResult = { ok: true; model: ObjectMatteInstall } | { ok: false; message: string };

const shape = (m: ModelInstall): ObjectMatteInstall => ({
  encoderUrl: m.urls[0] ?? '',
  decoderUrl: m.urls[1] ?? '',
  bytes: m.bytes,
  installedAt: m.installedAt,
});

/** The folder the engine reads the user's model from. */
export function objectMatteUserDir(userData: string): string {
  return path.join(userData, 'models', 'object-matte');
}

/** The installed model, or null when the folder does not hold a complete one. */
export async function readObjectMatteInstall(dir: string): Promise<ObjectMatteInstall | null> {
  const m = await readModelInstall(dir, FILES);
  return m ? shape(m) : null;
}

/** Download both files, check they are ONNX, then put them in place. */
export async function installObjectMatte(
  dir: string,
  encoderUrl: string,
  decoderUrl: string,
  signal: AbortSignal,
  emit: (receivedBytes: number, totalBytes: number | null) => void,
): Promise<ObjectMatteInstallResult> {
  const res = await installModelFiles(
    dir,
    [
      { name: ENCODER_FILE, url: encoderUrl, sha256: null, bytes: null },
      { name: DECODER_FILE, url: decoderUrl, sha256: null, bytes: null },
    ],
    signal,
    emit,
    ['encoder', 'decoder'],
  );
  return res.ok ? { ok: true, model: shape(res.model) } : res;
}

/** Remove the user's model; the engine goes back to the bundled one. */
export async function removeObjectMatte(dir: string): Promise<void> {
  await removeModel(dir, FILES);
}
