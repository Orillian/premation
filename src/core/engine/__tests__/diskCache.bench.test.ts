/**
 * The disk cache (native/engine/src/render/disk_cache.hpp) on a heavy 1080p
 * comp — 40 rectangles with drop shadow + blur or glow, every frame different.
 * Three fills of the same second (Cache Work Area), each in a fresh engine
 * process so the VRAM cache is cold:
 *
 *   off     the disk cache off: every frame drawn
 *   auto    on, the engine's policy: these frames draw faster than a disk
 *           read would serve them, so none is written and nothing is paid
 *   write   on, every frame forced to disk: drawn, read back and written
 *   hit     on, the folder `write` filled: every frame read from disk
 *
 * Per-frame ms is render start → done as the engine reports it (FrameReady).
 * Run with the bench jest config — the default suite ignores `*.bench.test.ts`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessEngineClient, secondsToFlicks, unwrap } from '@motion/engine-api';
import type { EngineFrameMessage } from '../../../../electron/engineFraming';
import { nativeEngineExe, startNativeEngine } from '../__testHelpers__/nativeEngine';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const LAYERS = 40;
/** Full-frame Fractal Noise layers on top (PREMATION_DISK_BENCH_HEAVY, default 0). */
const HEAVY = Number(process.env.PREMATION_DISK_BENCH_HEAVY ?? 0);

function p50(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

async function fillOnce(project: string, diskFolder: string | null, build: boolean, forceDisk = false): Promise<{ p50: number; wall: number; frames: number; files: number }> {
  const extra = process.env.PREMATION_DISK_BENCH_AUTO_ARGS && diskFolder && !forceDisk ? process.env.PREMATION_DISK_BENCH_AUTO_ARGS.split(' ') : [];
  const native = await startNativeEngine({
    extraArgs: ['--frame-cache-mb', '2048', '--log-level', 'warn', ...(forceDisk ? ['--disk-cache-min-draw-ms', '0'] : extra)],
  });
  const client = new ProcessEngineClient(native.bridge);
  let phase = 'idle';
  const ms: number[] = [];
  native.supervisor.on('frame', (m: EngineFrameMessage) => {
    if (m.type !== 'frameReady') return;
    native.supervisor.releaseSlot(m.generation, m.slot);
    if (phase === 'caching') ms.push((m.renderDoneUs - m.renderStartUs) / 1000);
  });
  client.subscribe((batch) => {
    for (const e of batch.events) if (e.type === 'transportChanged') phase = e.state;
  });
  try {
    unwrap(await client.execute({ type: 'setCacheBudget', ramMegabytes: 0, diskMegabytes: diskFolder ? 8192 : 0, diskPath: diskFolder ?? '' }));
    let comp: string;
    if (build) {
      await client.execute({ type: 'newProject' });
      const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
      comp = doc.comps[0]!.id;
      await client.execute({ type: 'setCompositionSettings', comp, patch: { frameRate: { num: 30, den: 1 }, duration: secondsToFlicks(2), width: 1920, height: 1080 } });
      for (let i = 0; i < LAYERS; i++) {
        const layer = unwrap(await client.execute({ type: 'createLayer', comp, kind: 'rectangle', name: `R${i}`, init: [] })).layer;
        const x = 120 + (i % 10) * 180;
        const y = 160 + Math.floor(i / 10) * 220;
        await client.execute({
          type: 'addKeyframes',
          keys: [
            { prop: { layer, path: 'transform/position' }, time: 0, value: { kind: 'vec2', value: { x, y } }, spatialIn: [], spatialOut: [], easing: 'linear' },
            { prop: { layer, path: 'transform/position' }, time: secondsToFlicks(2), value: { kind: 'vec2', value: { x: x + 90, y: y + 60 } }, spatialIn: [], spatialOut: [], easing: 'linear' },
          ],
        });
        if (i % 2 === 0) {
          await client.execute({ type: 'addEffect', layers: [layer], effect: 'drop-shadow', params: [] });
          await client.execute({ type: 'addEffect', layers: [layer], effect: 'gaussian-blur', params: [] });
        } else {
          await client.execute({ type: 'addEffect', layers: [layer], effect: 'glow', params: [] });
        }
      }
      if (HEAVY) {
        // Full-frame procedural layers: the kind of frame a disk cache exists for.
        for (let i = 0; i < HEAVY; i++) {
          const layer = unwrap(await client.execute({ type: 'createLayer', comp, kind: 'solid', name: `Noise${i}`, init: [] })).layer;
          await client.execute({ type: 'addEffect', layers: [layer], effect: 'fractal-noise', params: [] });
          await client.execute({ type: 'setProperty', prop: { layer, path: 'transform/opacity' }, value: { kind: 'scalar', value: 30 } });
        }
      }
      unwrap(await client.execute({ type: 'saveProject', path: project, copy: false }));
    } else {
      unwrap(await client.execute({ type: 'openProject', path: project }));
      const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
      comp = doc.comps[0]!.id;
    }
    await client.execute({ type: 'setActiveComposition', comp });
    await client.execute({
      type: 'setViewport', viewport: 1, width: 1920, height: 1080, devicePixelRatio: 1, zoom: 1,
      pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true,
    });
    await client.execute({ type: 'setLoop', mode: 'once' });
    await sleep(1500);  // the first frame + the folder scan + pipeline warm-up, outside the measure
    ms.length = 0;
    const t0 = Date.now();
    await client.execute({
      type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: secondsToFlicks(1) },
      audio: false, cacheFirst: true, cacheOnly: true,
    });
    await sleep(100);
    const until = Date.now() + 120_000;
    while (phase !== 'stopped' && Date.now() < until) await sleep(10);
    const wall = Date.now() - t0;
    if (diskFolder) await sleep(3000);  // let the writer finish before the process goes
    const dir = diskFolder ? path.join(diskFolder, 'premation-frames-v1') : '';
    const files = dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.pfc')).length : 0;
    return { p50: Number(p50(ms).toFixed(2)), wall, frames: ms.length, files };
  } finally {
    await native.stop();
  }
}

describe('disk cache', () => {
  it('writes only frames worth it; what a forced write and a disk hit cost', async () => {
    if (!nativeEngineExe()) {
      console.log('[disk] premation-engine is not built');
      return;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'premation-disk-bench-'));
    const project = path.join(root, 'heavy.premation');
    const folder = path.join(root, 'Disk Cache');
    try {
      const off = await fillOnce(project, null, true);
      // The engine's policy: these frames draw faster than a disk read, so none is written and nothing is paid.
      const auto = await fillOnce(project, path.join(root, 'Auto'), false);
      // The off run again: the spread between the two is the noise any difference above has to beat.
      const off2 = await fillOnce(project, null, false);
      // Every frame forced to disk: the write's cost, then a fresh process reading them all back.
      const write = await fillOnce(project, folder, false, true);
      const hit = await fillOnce(project, folder, false, true);
      console.log('[disk] ' + JSON.stringify({ off, auto, off2, write, hit }));
      // Auto mode's policy since 98f33183 (2026-10-25, RenderThread::worth_disk):
      // a cache FILL (the cacheFirst play above) stores EVERY frame it draws —
      // a cheap frame RAM refused would otherwise sit in no tier and the range
      // the user just cached would play with a hole. Outside a fill only a
      // frame whose draw costs half again its read-back is written. So the
      // fill's file count is the range (a frame or two may still be in the
      // writer when the process goes), and the writes must not slow the fill.
      expect(auto.files).toBeGreaterThanOrEqual(Math.max(1, auto.frames - 2));
      expect(auto.p50).toBeLessThanOrEqual(Math.max(off.p50, off2.p50) * 1.25 + 0.5);
      expect(hit.frames).toBeGreaterThanOrEqual(30);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 600_000);
});
