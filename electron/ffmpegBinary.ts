/**
 * Which ffmpeg an export runs — one rule for both renderers (the Chromium raw
 * pipe in main.ts and the engine's export jobs, engineExport.ts), so the two
 * paths can never encode with different binaries:
 *
 *   1. the copy the health check verified (electron/ffmpegHealth.ts) — which
 *      may be FFMPEG_PATH, one the person chose, the bundled one or a repaired one;
 *   2. FFMPEG_PATH, when it names a file that exists (before the first check);
 *   3. the bundled copy, `<resources>/ffmpeg/ffmpeg[.exe]`;
 *   4. the repaired copy the app downloaded, `<userData>/tools/ffmpeg/<pin>/`
 *      (electron/ffmpegRepair.ts), when the caller says where userData is;
 *   5. `ffmpeg` on PATH.
 *
 * Steps 3–5 are the answer before the first health check has run (the engine
 * is spawned at startup, before it finishes) and its fallback if the verified
 * file disappears afterwards.
 *
 * Electron-free (everything it reads is handed in).
 */

import path from 'node:path';
import manifest from './ffmpegManifest.json';

export const ffmpegExeName = (platform: NodeJS.Platform): string => (platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

/** `<userData>/tools/ffmpeg` — the repair's working folder (downloads, installed copies, the person's choice). */
export function ffmpegToolsDir(userDataPath: string): string {
  return path.join(userDataPath, 'tools', 'ffmpeg');
}

/**
 * Where the repair installs the pinned build: a folder named after the pin, so a
 * new pin never overwrites a copy an export may be running (Windows cannot
 * replace a running .exe) and an old one is simply left for cleanup.
 */
export function repairedFfmpegPath(userDataPath: string, platform: NodeJS.Platform, arch: string): string | null {
  const build = (manifest.builds as Record<string, { sha256: string } | undefined>)[`${platform}-${arch}`];
  if (!build) return null;
  return path.join(ffmpegToolsDir(userDataPath), build.sha256.slice(0, 16), ffmpegExeName(platform));
}

/** The bundled copy's path (whether or not it exists). */
export function bundledFfmpegPath(resourcesPath: string, platform: NodeJS.Platform): string {
  return path.join(resourcesPath, 'ffmpeg', ffmpegExeName(platform));
}

let verified: string | null = null;

/** Set by the health check: the copy that ran and has the encoders. `null` forgets it. */
export function setVerifiedFfmpeg(bin: string | null): void {
  verified = bin;
}

export function resolveFfmpegBinary(env: {
  vars: Record<string, string | undefined>;
  resourcesPath: string;
  platform: NodeJS.Platform;
  exists: (p: string) => boolean;
  /** app.getPath('userData'): enables the repaired copy (step 4). */
  userDataPath?: string;
  arch?: string;
}): string {
  // The health check tries FFMPEG_PATH first, so when it RAN, its answer
  // already prefers the override — and skips one that exists but is broken.
  if (verified && (verified === 'ffmpeg' || env.exists(verified))) return verified;
  const override = env.vars.FFMPEG_PATH;
  if (override && env.exists(override)) return override;
  const bundled = bundledFfmpegPath(env.resourcesPath, env.platform);
  if (env.exists(bundled)) return bundled;
  if (env.userDataPath) {
    const repaired = repairedFfmpegPath(env.userDataPath, env.platform, env.arch ?? process.arch);
    if (repaired && env.exists(repaired)) return repaired;
  }
  return 'ffmpeg';
}
