/**
 * The preview cache's disk tier (native/engine/src/render/disk_cache.hpp),
 * After Effects' Disk Cache: frames the engine draws are written to a folder,
 * survive the engine process, and are read back instead of rendered.
 *
 *   1. One engine: Cache Work Area with the disk cache on — the frames land in
 *      `<folder>/premation-frames-v1`, the blue lane (`disk` ranges) covers
 *      them and `diskBytes` counts them.
 *   2. A NEW engine process over the same folder and the saved project: the
 *      same fill is served from disk — every frame on the blue lane, and not
 *      one new file written.
 *   3. Purge Disk Cache empties the folder and the lane.
 *
 * `--disk-cache-min-draw-ms 0`: this comp draws in well under a millisecond,
 * which the engine's own policy (only frames slower than a disk read) would
 * keep off the disk.
 *
 * Needs a GPU adapter (PREMATION_GPU_TESTS=1), like the other full-renderer suites.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessEngineClient, secondsToFlicks, unwrap } from '@motion/engine-api';
import type { EngineFrameMessage } from '../../../electron/engineFraming';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from './__testHelpers__/nativeEngine';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const suite = process.env.PREMATION_GPU_TESTS === '1' && nativeEngineExe() ? describe : describe.skip;

const FPS = 30;
const FRAME = secondsToFlicks(1 / FPS);
const frameCount = (ranges: ReadonlyArray<{ start: number; end: number }>): number =>
  ranges.reduce((n, r) => n + Math.round((r.end - r.start) / FRAME), 0);

interface Session {
  native: NativeEngine;
  client: ProcessEngineClient;
  phase: () => string;
  /** Render start → done of the first frame this engine process drew, ms (null before one). */
  firstFrameMs: () => number | null;
}

/** `policy` 'every' writes every exact frame; 'auto' is the engine's own (only frames slower than a disk read). */
async function open(policy: 'every' | 'auto' = 'every'): Promise<Session> {
  // Idle render-ahead off (PREMATION_IDLE_PREFETCH): the counts below are what the
  // fills wrote; a purge must stay empty rather than refill within a second.
  const native = await startNativeEngine({
    extraArgs: ['--frame-cache-mb', '1024', '--log-level', 'warn', ...(policy === 'every' ? ['--disk-cache-min-draw-ms', '0'] : [])],
  }, { PREMATION_IDLE_PREFETCH: '0' });
  const client = new ProcessEngineClient(native.bridge);
  let phase = 'idle';
  let firstMs: number | null = null;
  native.supervisor.on('frame', (m: EngineFrameMessage) => {
    if (m.type !== 'frameReady') return;
    firstMs ??= (m.renderDoneUs - m.renderStartUs) / 1000;
    native.supervisor.releaseSlot(m.generation, m.slot);
  });
  client.subscribe((batch) => {
    for (const e of batch.events) if (e.type === 'transportChanged') phase = e.state;
  });
  return { native, client, phase: () => phase, firstFrameMs: () => firstMs };
}

/** A 2 s, 30 fps, 640×360 comp holding the test clip, saved to `project`; its id. */
async function buildClipProject(client: ProcessEngineClient, project: string, clip: string): Promise<string> {
  await client.execute({ type: 'newProject' });
  const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
  const comp = doc.comps[0]!.id;
  await client.execute({ type: 'setCompositionSettings', comp, patch: { frameRate: { num: FPS, den: 1 }, duration: secondsToFlicks(2), width: 640, height: 360 } });
  await client.execute({ type: 'setActiveComposition', comp });
  const item = unwrap(await client.execute({ type: 'importFiles', files: [{ path: clip, asSequence: false, createComposition: false }] })).items[0]!;
  unwrap(await client.execute({ type: 'createLayer', comp, kind: 'video', source: item, init: [] }));
  unwrap(await client.execute({ type: 'saveProject', path: project, copy: false }));
  return comp;
}

/** Whether the disk lane covers frame 0. */
const diskHasFirstFrame = (ranges: ReadonlyArray<{ start: number; end: number }>): boolean => ranges.some((r) => r.start <= 0 && r.end > 0);

async function showViewport(client: ProcessEngineClient): Promise<void> {
  await client.execute({
    type: 'setViewport', viewport: 1, width: 640, height: 360, devicePixelRatio: 1, zoom: 1,
    pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true,
  });
}

/** Cache Work Area over the first second, until the transport stops. */
async function fill(s: Session): Promise<void> {
  await s.client.execute({ type: 'setLoop', mode: 'once' });
  await s.client.execute({
    type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: secondsToFlicks(1) },
    audio: false, cacheFirst: true, cacheOnly: true,
  });
  const until = Date.now() + 60_000;
  await sleep(200);
  while (s.phase() !== 'stopped' && Date.now() < until) await sleep(50);
  expect(s.phase()).toBe('stopped');
}

/** The disk lane once the writer has caught up (it writes behind the render thread). */
async function diskCoverage(s: Session, comp: string, atLeast: number): Promise<{ frames: number; bytes: number }> {
  const until = Date.now() + 20_000;
  for (;;) {
    const cov = unwrap(await s.client.query({ type: 'getCacheCoverage', comp }));
    const frames = frameCount(cov.disk);
    if (frames >= atLeast || Date.now() > until) return { frames, bytes: cov.diskBytes };
    await sleep(100);
  }
}

const filesIn = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.pfc')) : []);

suite('the disk cache', () => {
  it('writes frames, serves them to a new engine process, and purges', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'premation-disk-cache-'));
    const folder = path.join(root, 'Disk Cache');
    const frames = path.join(folder, 'premation-frames-v1');
    const project = path.join(root, 'shot.premation');
    const clip = path.resolve(__dirname, '../../../packages/render-tests/scenes/video-decoded-frame.media/media-0.mp4');
    const budget = { type: 'setCacheBudget' as const, ramMegabytes: 0, diskMegabytes: 2048, diskPath: folder };

    // 1. Fill: every frame of the second lands on disk.
    let comp = '';
    const first = await open();
    try {
      unwrap(await first.client.execute(budget));
      comp = await buildClipProject(first.client, project, clip);
      await showViewport(first.client);
      await fill(first);
      const disk = await diskCoverage(first, comp, FPS);
      expect(disk.frames).toBeGreaterThanOrEqual(FPS);
      expect(disk.bytes).toBeGreaterThan(0);
      expect(filesIn(frames).length).toBeGreaterThanOrEqual(FPS);
    } finally {
      await first.native.stop();
    }
    const written = filesIn(frames).length;

    // 2. A new process: its VRAM cache is empty, the folder is not.
    const second = await open();
    try {
      unwrap(await second.client.execute(budget));
      unwrap(await second.client.execute({ type: 'openProject', path: project }));
      await second.client.execute({ type: 'setActiveComposition', comp });
      await showViewport(second.client);
      await sleep(500);  // the folder scan
      await fill(second);
      const cov = unwrap(await second.client.query({ type: 'getCacheCoverage', comp }));
      expect(frameCount(cov.ram)).toBeGreaterThanOrEqual(FPS);   // promoted back into VRAM
      expect(frameCount(cov.disk)).toBeGreaterThanOrEqual(FPS);  // and known to be on disk
      await sleep(500);
      expect(filesIn(frames).length).toBe(written);  // read, never drawn and written again

      // 3. Purge Disk Cache.
      unwrap(await second.client.execute({ type: 'purgeCache', kind: 'disk' }));
      const until = Date.now() + 10_000;
      while (filesIn(frames).length > 0 && Date.now() < until) await sleep(100);
      expect(filesIn(frames)).toEqual([]);
      const after = unwrap(await second.client.query({ type: 'getCacheCoverage', comp }));
      expect(after.diskBytes).toBe(0);
      expect(frameCount(after.disk)).toBe(0);
    } finally {
      await second.native.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  // The engine's own policy decides on each frame's real draw time: the
  // first frame a process draws (decoder open, pipelines, rasters) is its
  // slowest, and the one a prediction from earlier frames never sees. It used
  // to stay off the disk on every run — a restart drew it again.
  it('auto policy: the slow first frame goes to disk and the next process reads it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'premation-disk-cache-auto-'));
    const folder = path.join(root, 'Disk Cache');
    const project = path.join(root, 'shot.premation');
    const clip = path.resolve(__dirname, '../../../packages/render-tests/scenes/video-decoded-frame.media/media-0.mp4');
    const budget = { type: 'setCacheBudget' as const, ramMegabytes: 0, diskMegabytes: 2048, diskPath: folder };

    let comp = '';
    let firstMs = 0;
    const first = await open('auto');
    try {
      unwrap(await first.client.execute(budget));
      comp = await buildClipProject(first.client, project, clip);
      await showViewport(first.client);
      await fill(first);
      firstMs = first.firstFrameMs() ?? 0;
      const until = Date.now() + 20_000;
      let cov = unwrap(await first.client.query({ type: 'getCacheCoverage', comp }));
      while (!diskHasFirstFrame(cov.disk) && Date.now() < until) {
        await sleep(100);
        cov = unwrap(await first.client.query({ type: 'getCacheCoverage', comp }));
      }
      expect(diskHasFirstFrame(cov.disk)).toBe(true);
    } finally {
      await first.native.stop();
    }

    const second = await open('auto');
    try {
      unwrap(await second.client.execute(budget));
      await sleep(500);  // the folder scan, before the first frame is asked for
      unwrap(await second.client.execute({ type: 'openProject', path: project }));
      await second.client.execute({ type: 'setActiveComposition', comp });
      await showViewport(second.client);
      await fill(second);
      const secondMs = second.firstFrameMs() ?? Infinity;
      // A file read instead of the draw: well under what drawing it cost.
      expect(secondMs).toBeLessThan(firstMs / 2);
      const cov = unwrap(await second.client.query({ type: 'getCacheCoverage', comp }));
      expect(diskHasFirstFrame(cov.disk)).toBe(true);
    } finally {
      await second.native.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
