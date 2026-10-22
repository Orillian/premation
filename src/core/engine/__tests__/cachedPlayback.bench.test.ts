/**
 * Cached playback without a build, on a heavy 1080p comp: 60 animated
 * rectangles with Drop Shadow + Gaussian Blur (half) or Glow (the rest) — the
 * heavyScene bench's shape, where one scene build is tens to hundreds of ms.
 *
 * The range is filled once (cacheFirst), then played from the cache twice.
 * Every frame of those passes is in a cache tier, so what remains per frame
 * is the engine's per-frame work OUTSIDE the draw: before the pre-build key
 * (core/frame_keys.hpp) each played frame still paid the whole scene build;
 * with it a frame whose key the render thread has seen built is presented
 * straight from a tier. Printed per pass: the frames delivered, dropped, the
 * wall time between frames (p50 / p95), the render-thread time per frame,
 * and the engine's own cpuFrameMs / cacheHitRate. Recorded for the ratchet as
 * `cachedPlayback/heavy60-1080p`.
 *
 * PREMATION_BENCH_LAYERS=<n> changes the layer count. Run with the bench jest
 * config — the default suite ignores `*.bench.test.ts`.
 */
import { ProcessEngineClient, secondsToFlicks, unwrap } from '@motion/engine-api';
import type { EngineFrameMessage } from '../../../../electron/engineFraming';
import { recordBench } from '../../perf/bench/benchRecord';
import { nativeEngineExe, startNativeEngine } from '../__testHelpers__/nativeEngine';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pct(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
}

const LAYERS = Number(process.env.PREMATION_BENCH_LAYERS ?? '1000');
const FPS = Number(process.env.PREMATION_BENCH_FPS ?? '60');
const SECONDS = 2;

interface Sample {
  frame: number;
  ms: number;
  dropped: number;
  at: number;
  phase: string;
}

describe('cached playback: a heavy comp plays from the cache without a build', () => {
  it(`fills ${SECONDS} s of ${LAYERS} effect layers once, then plays it twice from the cache`, async () => {
    if (!nativeEngineExe()) {
      console.log('[cached] premation-engine is not built');
      return;
    }
    const native = await startNativeEngine({ extraArgs: ['--frame-cache-mb', '2048', '--log-level', 'warn'] });
    const client = new ProcessEngineClient(native.bridge);
    let phase = 'idle';
    const samples: Sample[] = [];
    native.supervisor.on('frame', (m: EngineFrameMessage) => {
      if (m.type !== 'frameReady') return;
      native.supervisor.releaseSlot(m.generation, m.slot);
      samples.push({ frame: m.frame, ms: (m.renderDoneUs - m.renderStartUs) / 1000, dropped: m.dropped, at: performance.now(), phase });
    });
    client.subscribe((batch) => {
      for (const e of batch.events) if (e.type === 'transportChanged') phase = e.state;
    });
    const metrics: Parameters<typeof recordBench>[0] = [];
    try {
      await client.execute({ type: 'newProject' });
      const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
      const comp = doc.comps[0]!.id;
      await client.execute({
        type: 'setCompositionSettings',
        comp,
        patch: { frameRate: { num: FPS, den: 1 }, duration: secondsToFlicks(SECONDS + 1), width: 1920, height: 1080 },
      });
      await client.execute({ type: 'setActiveComposition', comp });
      for (let i = 0; i < LAYERS; i++) {
        const layer = unwrap(await client.execute({ type: 'createLayer', comp, kind: 'rectangle', name: `R${i}`, init: [] })).layer;
        const x = 120 + (i % 10) * 180;
        const y = 160 + Math.floor(i / 10) * 150;
        await client.execute({
          type: 'addKeyframes',
          keys: [
            { prop: { layer, path: 'transform/position' }, time: 0, value: { kind: 'vec2', value: { x, y } }, spatialIn: [], spatialOut: [], easing: 'linear' },
            { prop: { layer, path: 'transform/position' }, time: secondsToFlicks(SECONDS), value: { kind: 'vec2', value: { x: x + 90, y: y + 60 } }, spatialIn: [], spatialOut: [], easing: 'linear' },
            { prop: { layer, path: 'transform/rotation' }, time: 0, value: { kind: 'scalar', value: 0 }, spatialIn: [], spatialOut: [], easing: 'linear' },
            { prop: { layer, path: 'transform/rotation' }, time: secondsToFlicks(SECONDS), value: { kind: 'scalar', value: 45 }, spatialIn: [], spatialOut: [], easing: 'linear' },
          ],
        });
        if (i % 2 === 0) {
          await client.execute({ type: 'addEffect', layers: [layer], effect: 'drop-shadow', params: [] });
          await client.execute({ type: 'addEffect', layers: [layer], effect: 'gaussian-blur', params: [] });
        } else {
          await client.execute({ type: 'addEffect', layers: [layer], effect: 'glow', params: [] });
        }
      }
      await client.execute({
        type: 'setViewport',
        viewport: 1, width: 1920, height: 1080, devicePixelRatio: 1, zoom: 1,
        pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false,
        displayTransform: '', layerRenderEffects: true,
      });
      await client.execute({ type: 'setLoop', mode: 'once' });

      const report = async (label: string, pass: Sample[]): Promise<{ intervalP50Ms: number; wallMs: number; dropped: number }> => {
        const stats = unwrap(await client.query({ type: 'getRenderStats' }));
        const gaps = pass.slice(1).map((f, i) => f.at - pass[i]!.at);
        const wallMs = pass.length > 1 ? pass[pass.length - 1]!.at - pass[0]!.at : 0;
        const line = {
          pass: label,
          frames: pass.length,
          dropped: pass.reduce((n, f) => n + f.dropped, 0),
          wallMs: Number(wallMs.toFixed(0)),
          intervalP50Ms: Number(pct(gaps, 0.5).toFixed(1)),
          intervalP95Ms: Number(pct(gaps, 0.95).toFixed(1)),
          renderP50Ms: Number(pct(pass.map((f) => f.ms), 0.5).toFixed(2)),
          cpuFrameMs: Number(stats.cpuFrameMs.toFixed(2)),
          cacheHitRate: Number(stats.cacheHitRate.toFixed(2)),
          fps: Number(stats.fps.toFixed(1)),
        };
        console.log('[cached] ' + JSON.stringify(line));
        return { intervalP50Ms: line.intervalP50Ms, wallMs: line.wallMs, dropped: line.dropped };
      };
      const playUntilStopped = async (): Promise<void> => {
        const until = Date.now() + 180_000;
        while (phase !== 'stopped' && Date.now() < until) await sleep(20);
        expect(phase).toBe('stopped');
      };

      // Pass 0: the fill (every frame builds and draws), then the play that follows it.
      samples.length = 0;
      await client.execute({
        type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: secondsToFlicks(SECONDS) },
        audio: false, cacheFirst: true, cacheOnly: false,
      });
      await playUntilStopped();
      const fill = samples.filter((s) => s.phase === 'caching');
      const first = samples.filter((s) => s.phase === 'playing');
      console.log('[cached] ' + JSON.stringify({ pass: 'fill', frames: fill.length, renderP50Ms: Number(pct(fill.map((f) => f.ms), 0.5).toFixed(2)) }));
      // The phase label lags the frame channel by an event: the fill's last frame
      // or two may be tagged 'playing' already.
      expect(new Set(fill.map((s) => s.frame)).size).toBeGreaterThanOrEqual(SECONDS * FPS - 2);
      const r1 = await report('play-after-fill', first);

      // Pass 2: the same range again, from the cache.
      samples.length = 0;
      await client.execute({ type: 'seek', time: 0, mode: 'exact' });
      await sleep(200);
      samples.length = 0;
      await client.execute({
        type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: secondsToFlicks(SECONDS) },
        audio: false, cacheFirst: false, cacheOnly: false,
      });
      await playUntilStopped();
      const second = samples.filter((s) => s.phase === 'playing');
      const r2 = await report('play-cached', second);
      expect(second.length).toBeGreaterThan(0);

      metrics.push(
        { name: `cachedPlayback/heavy${LAYERS}-1080p${FPS}`, metric: 'playAfterFill.intervalP50', unit: 'ms', value: r1.intervalP50Ms, samples: first.length },
        { name: `cachedPlayback/heavy${LAYERS}-1080p${FPS}`, metric: 'playCached.intervalP50', unit: 'ms', value: r2.intervalP50Ms, samples: second.length },
        { name: `cachedPlayback/heavy${LAYERS}-1080p${FPS}`, metric: 'playCached.wall', unit: 'ms', value: r2.wallMs, samples: second.length },
        { name: `cachedPlayback/heavy${LAYERS}-1080p${FPS}`, metric: 'playCached.dropped', unit: 'count', value: r2.dropped, samples: 0 },
      );
    } finally {
      await native.stop();
      if (metrics.length > 0) recordBench(metrics);
    }
  }, 400_000);
});
