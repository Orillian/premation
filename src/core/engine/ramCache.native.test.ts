/**
 * The preview cache's RAM tier (native/engine/src/render/ram_cache.hpp) and
 * the coverage bars, on the GPU engine:
 *
 *   1. A range longer than VRAM holds: VRAM is capped at 16 MB (about 17
 *      frames at 640×360), the range is 90 frames. Cache Work Area stores
 *      them all — the frames VRAM evicts land in RAM — the green bar covers
 *      the whole range, and a played pass is served from the cache.
 *   2. The bars tell the truth: after an edit only what was drawn since
 *      counts, and another comp never shows this one's frames.
 *
 * Needs a GPU adapter (PREMATION_GPU_TESTS=1), like the other full-renderer suites.
 */

import { ProcessEngineClient, secondsToFlicks, unwrap } from '@motion/engine-api';
import type { EngineFrameMessage } from '../../../electron/engineFraming';
import { nativeEngineExe, startNativeEngine } from './__testHelpers__/nativeEngine';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const suite = process.env.PREMATION_GPU_TESTS === '1' && nativeEngineExe() ? describe : describe.skip;

const FPS = 30;
const SECONDS = 3;
const FRAMES = FPS * SECONDS;
const FRAME = secondsToFlicks(1 / FPS);
const frameCount = (ranges: ReadonlyArray<{ start: number; end: number }>): number =>
  ranges.reduce((n, r) => n + Math.round((r.end - r.start) / FRAME), 0);

suite('the RAM tier', () => {
  it('holds a range longer than VRAM, plays it from the cache, and keeps the bars honest', async () => {
    const native = await startNativeEngine({ extraArgs: ['--frame-cache-mb', '16', '--ram-cache-mb', '512', '--log-level', 'warn'] });
    const client = new ProcessEngineClient(native.bridge);
    let phase = 'idle';
    native.supervisor.on('frame', (m: EngineFrameMessage) => {
      if (m.type === 'frameReady') native.supervisor.releaseSlot(m.generation, m.slot);
    });
    client.subscribe((batch) => {
      for (const e of batch.events) if (e.type === 'transportChanged') phase = e.state;
    });
    const untilStopped = async (): Promise<void> => {
      const until = Date.now() + 90_000;
      await sleep(200);
      while (phase !== 'stopped' && Date.now() < until) await sleep(25);
      expect(phase).toBe('stopped');
    };
    const coverage = async (comp: string) => unwrap(await client.query({ type: 'getCacheCoverage', comp }));
    try {
      await client.execute({ type: 'newProject' });
      const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
      const comp = doc.comps[0]!.id;
      await client.execute({ type: 'setCompositionSettings', comp, patch: { frameRate: { num: FPS, den: 1 }, duration: secondsToFlicks(SECONDS), width: 640, height: 360 } });
      await client.execute({ type: 'setActiveComposition', comp });
      const layers: string[] = [];
      for (let i = 0; i < 6; i++) {
        const layer = unwrap(await client.execute({ type: 'createLayer', comp, kind: 'rectangle', name: `R${i}`, init: [] })).layer;
        layers.push(layer);
        const x = 60 + i * 90;
        await client.execute({
          type: 'addKeyframes',
          keys: [
            { prop: { layer, path: 'transform/position' }, time: 0, value: { kind: 'vec2', value: { x, y: 80 } }, spatialIn: [], spatialOut: [], easing: 'linear' },
            { prop: { layer, path: 'transform/position' }, time: secondsToFlicks(SECONDS), value: { kind: 'vec2', value: { x: x + 40, y: 280 } }, spatialIn: [], spatialOut: [], easing: 'linear' },
          ],
        });
      }
      await client.execute({
        type: 'setViewport', viewport: 1, width: 640, height: 360, devicePixelRatio: 1, zoom: 1,
        pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true,
      });
      await client.execute({ type: 'setLoop', mode: 'once' });
      await sleep(500);

      // 1. Cache Work Area over the whole range: VRAM keeps ~17 frames, RAM the rest.
      await client.execute({ type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: secondsToFlicks(SECONDS) }, audio: false, cacheFirst: true, cacheOnly: true });
      await untilStopped();
      await sleep(300);  // the last read-backs land in RAM
      const filled = await coverage(comp);
      expect(frameCount(filled.ram)).toBeGreaterThanOrEqual(FRAMES - 1);
      expect(filled.ramBytes).toBeGreaterThan(32 * 1024 * 1024);  // more than VRAM's 16 MB holds

      // A played pass is served from the cache, not drawn.
      await client.execute({ type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: secondsToFlicks(SECONDS) }, audio: false, cacheFirst: false, cacheOnly: false });
      await untilStopped();
      const stats = unwrap(await client.query({ type: 'getRenderStats' }));
      expect(stats.cacheHitRate).toBeGreaterThan(0.9);

      // 2. An edit: frames cached before it no longer show (they may still hit, if unchanged, when played).
      await client.execute({ type: 'setProperty', prop: { layer: layers[0]!, path: 'transform/opacity' }, value: { kind: 'scalar', value: 50 } });
      await sleep(500);
      expect(frameCount((await coverage(comp)).ram)).toBeLessThanOrEqual(2);

      // Another comp never shows this one's frames.
      const other = unwrap(await client.execute({
        type: 'createComposition', fromItems: [],
        settings: { name: 'Other', width: 640, height: 360, frameRate: { num: FPS, den: 1 }, duration: secondsToFlicks(SECONDS) },
      })).item;
      await client.execute({ type: 'setActiveComposition', comp: other });
      await sleep(500);
      expect(frameCount((await coverage(other)).ram)).toBeLessThanOrEqual(2);
    } finally {
      await native.stop();
    }
  }, 240_000);
});
