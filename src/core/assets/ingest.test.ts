/**
 * Import ingest: stills the engine cannot read as they are get converted, and
 * VIDEO never does — the engine decodes ProRes / DNx / MXF at full quality, so
 * a transcode would only lose bit depth and alpha (and read the whole file into
 * memory). Which files the page's <video> can play is browserPlayable's call.
 */

import { isCameraRawStill, maybeIngestForImport, rawStillEncodeArgs } from './ingest';
import { browserCanPlayVideo } from '@core/media/browserPlayable';

describe('camera raw stills', () => {
  it('recognises DNG/CR2 and builds a one-frame PNG encode', () => {
    expect(isCameraRawStill('shot.dng')).toBe(true);
    expect(isCameraRawStill('clip.mp4')).toBe(false);
    const { args, outExt } = rawStillEncodeArgs();
    expect(outExt).toBe('png');
    expect(args).toContain('-frames:v');
    expect(args).toContain('1');
  });
});

describe('video is imported as it is', () => {
  it('a ProRes .mov, an MXF and an AVI are never transcoded, even with ffmpeg on the bridge', async () => {
    const generateProxy = jest.fn();
    (window as unknown as { motionEditor: unknown }).motionEditor = { media: { generateProxy, probe: jest.fn() } };
    try {
      for (const name of ['shot.mov', 'tape.mxf', 'old.avi', 'clip.mkv']) {
        expect(await maybeIngestForImport(new File([new Uint8Array(8)], name, { type: 'video/quicktime' }))).toBeNull();
      }
      expect(generateProxy).not.toHaveBeenCalled();
    } finally {
      delete (window as unknown as { motionEditor?: unknown }).motionEditor;
    }
  });
});

describe('browserCanPlayVideo', () => {
  it('H.264 / VP9 in an MP4, MOV or WebM play in the page', () => {
    expect(browserCanPlayVideo('shot.mp4', 'h264')).toBe(true);
    expect(browserCanPlayVideo('shot.mov', 'h264')).toBe(true);
    expect(browserCanPlayVideo('shot.webm', 'vp9')).toBe(true);
    expect(browserCanPlayVideo('shot.mov', undefined)).toBe(true);
  });

  it('pro codecs and broadcast containers do not', () => {
    for (const codec of ['prores', 'ProRes 4444', 'dnxhd', 'cfhd', 'mpeg2video']) expect(browserCanPlayVideo('shot.mov', codec)).toBe(false);
    for (const name of ['tape.mxf', 'old.avi', 'cam.MTS', 'clip.mkv']) expect(browserCanPlayVideo(name, 'h264')).toBe(false);
  });
});
