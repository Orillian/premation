/**
 * Raster reuse under an animated scale, on the GPU engine: 60 text and polygon
 * layers scaling 10 % → 150 % over two seconds, played uncached. A layer's
 * raster follows its scale through the resolution tier ladder (1 then 2 at
 * these scales: below 100 % the layer keeps the 1× raster), and the texture key
 * leaves the raw scale out (scene_textures.cpp), so only the frame where the
 * tier changes should pay for a raster; the rest reuse it. Prints the engine's render time per frame, and the
 * frames grouped by tier, so a re-raster on every frame shows as a flat, high
 * line instead of three spikes.
 *
 * Run with the bench jest config — the default suite ignores `*.bench.test.ts`.
 */
import { ProcessEngineClient, secondsToFlicks, unwrap } from '@motion/engine-api';
import type { EngineFrameMessage } from '../../../../electron/engineFraming';
import { nativeEngineExe, startNativeEngine } from '../__testHelpers__/nativeEngine';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pct(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
}

const LAYERS = 60;
const FPS = 30;

describe('scale animation reuses the layer rasters', () => {
  it('plays 60 scaling text and polygon layers', async () => {
    if (!nativeEngineExe()) {
      console.log('[scaleRaster] premation-engine is not built');
      return;
    }
    const native = await startNativeEngine({ extraArgs: ['--frame-cache-mb', '0', '--log-level', 'warn'] });
    const client = new ProcessEngineClient(native.bridge);
    let phase = 'idle';
    const frames: { frame: number; ms: number; dropped: number }[] = [];
    native.supervisor.on('frame', (m: EngineFrameMessage) => {
      if (m.type !== 'frameReady') return;
      native.supervisor.releaseSlot(m.generation, m.slot);
      if (phase === 'playing') frames.push({ frame: m.frame, ms: (m.renderDoneUs - m.renderStartUs) / 1000, dropped: m.dropped });
    });
    client.subscribe((batch) => {
      for (const e of batch.events) if (e.type === 'transportChanged') phase = e.state;
    });
    try {
      await client.execute({ type: 'newProject' });
      const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
      const comp = doc.comps[0]!.id;
      await client.execute({ type: 'setCompositionSettings', comp, patch: { frameRate: { num: FPS, den: 1 }, duration: secondsToFlicks(3), width: 1920, height: 1080 } });
      await client.execute({ type: 'setActiveComposition', comp });
      for (let i = 0; i < LAYERS; i++) {
        const kind = i % 2 === 0 ? 'text' : 'polygon';
        const layer = unwrap(await client.execute({ type: 'createLayer', comp, kind, name: `Scale ${i}`, init: [] })).layer;
        const x = 120 + (i % 10) * 180;
        const y = 120 + Math.floor(i / 10) * 170;
        await client.execute({ type: 'setProperty', prop: { layer, path: 'transform/position' }, value: { kind: 'vec2', value: { x, y } } });
        await client.execute({
          type: 'addKeyframes',
          keys: [
            { prop: { layer, path: 'transform/scale' }, time: 0, value: { kind: 'vec2', value: { x: 10, y: 10 } }, spatialIn: [], spatialOut: [], easing: 'linear' },
            { prop: { layer, path: 'transform/scale' }, time: secondsToFlicks(2), value: { kind: 'vec2', value: { x: 150, y: 150 } }, spatialIn: [], spatialOut: [], easing: 'linear' },
          ],
        });
      }
      await client.execute({
        type: 'setViewport',
        viewport: 1, width: 1920, height: 1080, devicePixelRatio: 1, zoom: 1,
        pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false,
        displayTransform: '', layerRenderEffects: true,
      });
      await client.execute({ type: 'setLoop', mode: 'once' });
      // Twice: the first pass pays every tier's raster once, the second finds them cached.
      for (const pass of ['cold', 'warm'] as const) {
        frames.length = 0;
        phase = 'starting';
        await client.execute({
          type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: secondsToFlicks(2) },
          audio: false, cacheFirst: false, cacheOnly: false,
        });
        const until = Date.now() + 120_000;
        while (phase !== 'stopped' && Date.now() < until) await sleep(50);
        const ms = frames.map((f) => f.ms);
        // The tier at this frame's scale (frame_build.cpp Flattener::feed: the layer
        // scale counts from 1 up, then kTiers): 10 % → 150 % linear over 2 s.
        const tierOf = (frame: number): number => {
          const s = (10 + (140 * Math.min(frame, 2 * FPS)) / (2 * FPS)) / 100;
          return s <= 1 ? 1 : 2;
        };
        const byTier: Record<string, number[]> = {};
        for (const f of frames) (byTier[String(tierOf(f.frame))] ??= []).push(f.ms);
        const line = {
          pass,
          frames: frames.length,
          dropped: frames.reduce((n, f) => n + f.dropped, 0),
          renderP50Ms: Number(pct(ms, 0.5).toFixed(2)),
          renderP95Ms: Number(pct(ms, 0.95).toFixed(2)),
          renderMaxMs: Number(Math.max(0, ...ms).toFixed(2)),
          tierP50Ms: Object.fromEntries(Object.entries(byTier).map(([t, xs]) => [t, Number(pct(xs, 0.5).toFixed(2))])),
          perFrame: frames.map((f) => `${f.frame}:${f.ms.toFixed(1)}`).join(' '),
        };
        console.log('[scaleRaster] ' + JSON.stringify(line));
        expect(phase).toBe('stopped');
        expect(frames.length).toBeGreaterThan(0);
      }
      // The rasters drew: no layer reported a raster failure (a missing default
      // font is a notice — the text draws in a fallback face).
      const errors = unwrap(await client.query({ type: 'getLayerErrors', comp })).errors.filter((e) => e.stage !== 'font');
      expect(errors).toEqual([]);
    } finally {
      await native.stop();
    }
  }, 300_000);
});
