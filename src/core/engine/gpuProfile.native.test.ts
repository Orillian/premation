/**
 * What the Cache & Memory panel's video-memory row and "Heaviest layers" read
 * from the engine (`getRenderStats`):
 *
 *   - gpuMemoryBudget / gpuMemoryUsed / gpuMemoryTotal: the OS's view of the
 *     render adapter (DXGI on Windows; absent where the OS does not say);
 *   - layerCosts: one sampled frame's GPU time per root-level layer, asked
 *     for with `profileLayers` and drawn on the next uncached frame.
 *
 * The GPU figures come from the render thread, which the headless engine does
 * not have: there the fields are absent and the suite checks only that.
 */

import { ProcessEngineClient, secondsToFlicks, unwrap } from '@motion/engine-api';
import type { EngineFrameMessage } from '../../../electron/engineFraming';
import { nativeEngineExe, nativeEngineIsHeadless, startNativeEngine } from './__testHelpers__/nativeEngine';

const suite = nativeEngineExe() ? describe : describe.skip;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

suite('engine GPU memory and per-layer profile', () => {
  it('reports the OS video-memory budget and a per-layer GPU sample', async () => {
    const native = await startNativeEngine({ extraArgs: ['--frame-cache-mb', '0', '--log-level', 'warn'] });
    const client = new ProcessEngineClient(native.bridge);
    native.supervisor.on('frame', (m: EngineFrameMessage) => {
      if (m.type === 'frameReady') native.supervisor.releaseSlot(m.generation, m.slot);
    });
    try {
      await client.execute({ type: 'newProject' });
      const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
      const comp = doc.comps[0]!.id;
      await client.execute({
        type: 'setCompositionSettings', comp,
        patch: { width: 1280, height: 720, frameRate: { num: 30, den: 1 }, duration: secondsToFlicks(3) },
      });
      const layers: string[] = [];
      for (let i = 0; i < 3; i++) {
        const { layer } = unwrap(await client.execute({
          type: 'createLayer', comp, kind: 'rectangle', name: `R${i}`,
          init: [
            { path: 'transform/position', value: { kind: 'vec2', value: { x: 300 + i * 300, y: 360 } } },
            { path: 'transform/scale', value: { kind: 'vec2', value: { x: 200 + i * 100, y: 200 } } },
          ],
        }));
        layers.push(layer);
      }
      // A blend mode that reads the backdrop: that layer's draw costs passes of its own.
      await client.execute({ type: 'setBlendMode', layers: [layers[2]!], mode: 'overlay' });
      await client.execute({
        type: 'setViewport', viewport: 1, width: 1280, height: 720, devicePixelRatio: 1, zoom: 1,
        pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true,
      });

      const first = unwrap(await client.query({ type: 'getRenderStats' }));
      if (nativeEngineIsHeadless()) {
        expect(first.gpuMemoryBudget).toBeUndefined();
        expect(first.layerCosts).toEqual([]);
        return;
      }
      if (process.platform === 'win32') {
        // The probe reads once a second on the render thread.
        let stats = first;
        for (let i = 0; i < 40 && !stats.gpuMemoryBudget; i++) {
          await sleep(100);
          stats = unwrap(await client.query({ type: 'getRenderStats' }));
        }
        expect(stats.gpuMemoryBudget).toBeGreaterThan(0);
        expect(stats.gpuMemoryUsed).toBeGreaterThan(0);
        expect(stats.gpuMemoryTotal).toBeGreaterThan(0);
        expect(stats.gpuMemoryTrimmed).toBeGreaterThanOrEqual(0);
      }

      // Ask for a sample, then draw frames (uncached: the frame cache is off).
      await client.execute({ type: 'setLoop', mode: 'loop' });
      await client.execute({
        type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: secondsToFlicks(2) },
        audio: false, cacheFirst: false, cacheOnly: false,
      });
      let costs = unwrap(await client.query({ type: 'getRenderStats', profileLayers: true }));
      for (let i = 0; i < 50 && costs.layerCosts.length === 0; i++) {
        await sleep(100);
        costs = unwrap(await client.query({ type: 'getRenderStats', profileLayers: i % 5 === 0 }));
      }
      await client.execute({ type: 'pause', returnToStart: false });
      if (costs.layerCosts.length === 0) {
        // An adapter without TimestampQuery has no profiler: nothing to check.
        console.log('[gpuProfile] no sample (adapter without timestamp queries?)');
        return;
      }
      const ids = costs.layerCosts.filter((c) => c.kind === 'layer').map((c) => c.layer);
      for (const id of ids) expect(layers).toContain(id);
      // Every rectangle drew in its own scope.
      expect(new Set(ids).size).toBe(layers.length);
      for (const c of costs.layerCosts) {
        expect(c.gpuMs).toBeGreaterThanOrEqual(0);
        expect(c.passes).toBeGreaterThan(0);
      }
      // Heaviest first, and the frame total is their sum.
      const ms = costs.layerCosts.map((c) => c.gpuMs);
      expect([...ms].sort((a, b) => b - a)).toEqual(ms);
      const sum = ms.reduce((a, b) => a + b, 0);
      expect(costs.layerCostsFrameMs).toBeCloseTo(sum, 6);
      expect(costs.layerCostsAgoMs).toBeGreaterThanOrEqual(0);
    } finally {
      await native.stop();
    }
  }, 60_000);
});
