/**
 * Import ingest — stills the engine cannot read as they are, made importable.
 *
 * EXR (decoded in-process: float planes plus an sRGB preview), DPX, a PSD's
 * layers and camera-raw stills (ffmpeg / libraw on the desktop) are converted
 * at import. VIDEO is not: the engine decodes every format ffmpeg reads at
 * full quality, so footage is imported exactly as it is
 * (core/media/browserPlayable.ts says which files the page's own <video>
 * cannot play, and those panels show the engine's frames instead).
 */

import { t } from '@core/i18n';

/** Still camera-raw formats — ffmpeg often decodes via libraw/dcraw builds. */
const CAMERA_RAW_STILLS = new Set([
  'dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'raf', 'pef', 'srw', 'raw',
]);

const extOf = (name: string): string => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();

export function isCameraRawStill(fileName: string): boolean {
  return CAMERA_RAW_STILLS.has(extOf(fileName));
}

/**
 * ffmpeg args for a still camera-raw → PNG (one frame). Placeholders match
 * proxy/ingest IPC contract.
 */
export function rawStillEncodeArgs(): { args: string[]; outExt: string; mime: string } {
  return {
    args: [
      '-i', '__IN__',
      '-frames:v', '1',
      '-pix_fmt', 'rgb24',
      '__OUT__',
    ],
    outExt: 'png',
    mime: 'image/png',
  };
}

/**
 * Transcode `file` into a browser-playable File, or null when no ingest is
 * needed or possible (browser edition, ffmpeg absent, encode failed — every
 * one of which means "import the original exactly as before").
 */
export async function maybeIngestForImport(
  file: File,
  onStatus?: (msg: string) => void,
): Promise<File | null> {
  // EXR: decoded and tone-mapped in-process (no ffmpeg involved), so it works
  // in every edition. Failure falls through to importing the original bytes,
  // which surfaces as a broken image rather than a crashed import.
  if (/\.exr$/i.test(file.name)) {
    onStatus?.(t('core.ingest.decodingExr', 'Decoding “{name}” (EXR → float + sRGB preview)…', { name: file.name }));
    try {
      // Asset id is not known yet at ingest — float cache is filled after add.
      // Keep PNG preview path; float planes attach in assetStore post-import.
      const { convertExrToPngFile } = await import('@core/media/exrImport');
      return await convertExrToPngFile(file);
    } catch (e) {
      onStatus?.(t('core.ingest.exrFailed', 'EXR import failed: {error}', { error: e instanceof Error ? e.message : String(e) }));
      return null;
    }
  }
  if (/\.psd$/i.test(file.name)) {
    onStatus?.(t('core.ingest.decodingPsd', 'Decoding “{name}” (PSD layers)…', { name: file.name }));
    // PSD expands to multiple PNGs — handled specially in assetStore.addFiles.
    return null;
  }
  if (/\.dpx$/i.test(file.name)) {
    onStatus?.(t('core.ingest.decodingDpx', 'Decoding “{name}” (DPX → sRGB)…', { name: file.name }));
    const { convertDpxToPngFile } = await import('@core/media/dpxImport');
    try {
      return await convertDpxToPngFile(file);
    } catch (e) {
      onStatus?.(t('core.ingest.dpxFailed', 'DPX import failed: {error}', { error: e instanceof Error ? e.message : String(e) }));
      return null;
    }
  }

  // Camera raw stills (DNG/CR2/…) — ffmpeg/libraw when the host build supports it.
  if (isCameraRawStill(file.name)) {
    const bridge = typeof window !== 'undefined' ? window.motionEditor?.media : undefined;
    if (!bridge?.generateProxy) {
      onStatus?.(t('core.ingest.rawNeedsDesktop', 'Camera raw “{name}” needs the desktop app (ffmpeg).', { name: file.name }));
      return null;
    }
    onStatus?.(t('core.ingest.decodingRaw', 'Decoding camera raw “{name}”…', { name: file.name }));
    const { args, outExt, mime } = rawStillEncodeArgs();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const out = await bridge.generateProxy(
      `raw:${file.name}:${file.size}`,
      bytes,
      extOf(file.name) || 'dng',
      args,
      outExt,
    ).catch(() => null);
    if (!out) {
      onStatus?.(
        t('core.ingest.rawFailed', 'Camera raw decode failed for “{name}”. Host ffmpeg may lack libraw — convert to DNG/EXR externally.', { name: file.name }),
      );
      return null;
    }
    const base = file.name.replace(/\.[a-z0-9]+$/i, '');
    return new File([out as BlobPart], `${base}.${outExt}`, { type: mime });
  }

  // VIDEO is never transcoded any more. The engine decodes ProRes, DNxHD/HR,
  // MXF, AVI, CineForm… itself (ffmpeg, full bit depth, alpha kept), so the
  // original is imported as it is. The old 8-bit H.264 / VP9 re-encode —
  // written when every decode path ended at the browser — cost quality, read
  // the whole file into memory, and blocked the import for minutes on long
  // clips. Panels that still play footage in a browser <video> show the
  // engine's frames for these files (core/media/browserPlayable.ts).
  return null;
}
