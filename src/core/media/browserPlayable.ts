/**
 * Whether the page's own <video> element can play a footage file.
 *
 * The engine decodes every format ffmpeg reads (ProRes, DNxHD/HR, MXF, AVI,
 * CineForm…) at full quality, so footage is imported as it is. The few panels
 * that still play footage through a browser <video> (Source Monitor, Multicam,
 * the hover scrub) ask this first and show the engine's frames instead when
 * the browser cannot decode the file. Pure.
 */

/** Containers no browser <video> opens, whatever the codec. */
const UNPLAYABLE_CONTAINERS: ReadonlySet<string> = new Set([
  'mxf', 'avi', 'wmv', 'flv', 'mts', 'm2ts', 'mpg', 'mpeg', 'vob', 'mpe', 'ts', 'r3d', 'braw', 'ari', 'mkv',
]);

/** Codecs no browser decodes, in containers it otherwise could open (.mov, .mp4). */
const UNPLAYABLE_CODECS: readonly string[] = [
  'prores', 'dnxhd', 'dnxhr', 'mpeg2video', 'cineform', 'cfhd', 'ffv1', 'v210', 'rawvideo', 'mjpeg', 'jpeg2000',
  'huffyuv', 'qtrle', 'xdcam', 'imx', 'dvvideo', 'apch', 'apcn', 'apcs', 'apco', 'ap4h', 'hap', 'png', 'tiff', 'dpx', 'exr',
];

const extOf = (name: string): string => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();

/** False when the page's <video> cannot play this file (its container or its codec). */
export function browserCanPlayVideo(name: string, codec: string | undefined): boolean {
  if (UNPLAYABLE_CONTAINERS.has(extOf(name))) return false;
  if (!codec) return true;
  const c = codec.toLowerCase();
  return !UNPLAYABLE_CODECS.some((u) => c.includes(u));
}
