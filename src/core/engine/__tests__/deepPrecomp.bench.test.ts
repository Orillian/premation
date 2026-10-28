/**
 * Deep nesting on the GPU engine: 8 levels of precomps, each level a 1080p
 * composition holding the previous level as a precomp layer plus three
 * rectangles — every layer on a non-normal blend mode or partial opacity, so
 * the nested comp has to be drawn as its own picture and composited (an
 * inline / collapsed fallback would give a different frame). The precomp
 * layer of each level moves, so no level is a static picture. Like
 * heavyScene, two seconds are played with the frame cache OFF at full and
 * half preview resolution and one `[deep] {json}` line per resolution gives
 * the engine's cost per frame: the render-thread time (p50 / p95), the wall
 * interval between frames, the engine's own cpuFrameMs / gpuFrameMs.
 *
 * Recorded for the ratchet as `deepPrecomp/8levels-1080p`.
 *
 *   PREMATION_BENCH_DEPTH=<n>     nesting depth (default 8)
 *   PREMATION_BENCH_SHAPES=<n>    rectangles per level (default 3)
 *
 * Run with the bench jest config — the default suite ignores `*.bench.test.ts`.
 */
import { ProcessEngineClient, secondsToFlicks, unwrap, type BlendMode } from '@motion/engine-api';
import type { EngineFrameMessage } from '../../../../electron/engineFraming';
import { recordBench } from '../../perf/bench/benchRecord';
import { nativeEngineExe, startNativeEngine } from '../__testHelpers__/nativeEngine';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pct(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
}

const DEPTH = Number(process.env.PREMATION_BENCH_DEPTH ?? '8');
const SHAPES = Number(process.env.PREMATION_BENCH_SHAPES ?? '3');
const FPS = 30;
const SECONDS = 2;
const SCENARIO = `deepPrecomp/${DEPTH}levels-1080p`;
const SHAPE_MODES: BlendMode[] = ['multiply', 'screen', 'overlay', 'add', 'difference', 'soft-light'];

describe('deep precomps: 8 nested levels with blend modes and opacity', () => {
  it('plays two seconds uncached at full and half resolution and reports the cost per frame', async () => {
    if (!nativeEngineExe()) {
      console.log('[deep] premation-engine is not built');
      return;
    }
    const native = await startNativeEngine({ extraArgs: ['--frame-cache-mb', '0', '--log-level', 'warn'] });
    const client = new ProcessEngineClient(native.bridge);
    let phase = 'idle';
    const frames: { frame: number; ms: number; dropped: number; at: number }[] = [];
    native.supervisor.on('frame', (m: EngineFrameMessage) => {
      if (m.type !== 'frameReady') return;
      native.supervisor.releaseSlot(m.generation, m.slot);
      if (phase === 'playing') frames.push({ frame: m.frame, ms: (m.renderDoneUs - m.renderStartUs) / 1000, dropped: m.dropped, at: performance.now() });
    });
    client.subscribe((batch) => {
      for (const e of batch.events) if (e.type === 'transportChanged') phase = e.state;
    });
    const metrics: Parameters<typeof recordBench>[0] = [];
    const settings = { frameRate: { num: FPS, den: 1 }, duration: secondsToFlicks(SECONDS + 1), width: 1920, height: 1080 };
    /** `n` rectangles in `comp`, overlapping around the centre, each on its own blend mode and opacity. */
    const addShapes = async (comp: string, level: number): Promise<void> => {
      for (let i = 0; i < SHAPES; i++) {
        const angle = ((level * SHAPES + i) / (DEPTH * SHAPES)) * Math.PI * 2;
        const x = 960 + Math.cos(angle) * 220;
        const y = 540 + Math.sin(angle) * 160;
        const layer = unwrap(await client.execute({
          type: 'createLayer', comp, kind: 'rectangle', name: `L${level}S${i}`,
          init: [
            { path: 'transform/position', value: { kind: 'vec2', value: { x, y } } },
            { path: 'transform/scale', value: { kind: 'vec2', value: { x: 260, y: 260 } } },
            { path: 'transform/opacity', value: { kind: 'scalar', value: 55 + ((level + i) % 4) * 10 } },
          ],
        })).layer;
        await client.execute({ type: 'setBlendMode', layers: [layer], mode: SHAPE_MODES[(level + i) % SHAPE_MODES.length]! });
      }
    };
    try {
      const t0 = performance.now();
      await client.execute({ type: 'newProject' });
      const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
      let inner = doc.comps[0]!.id;
      await client.execute({ type: 'setCompositionSettings', comp: inner, patch: { ...settings, name: 'Level 0' } });
      await addShapes(inner, 0);
      for (let level = 1; level < DEPTH; level++) {
        const comp = unwrap(await client.execute({ type: 'createComposition', settings: { ...settings, name: `Level ${level}` }, fromItems: [] })).item;
        const nested = unwrap(await client.execute({ type: 'createLayer', comp, kind: 'precomp', name: `Level ${level - 1}`, source: inner, init: [] })).layer;
        // The nested comp is composited, never inlined: a blend mode and an opacity of its own, and it moves.
        await client.execute({ type: 'setBlendMode', layers: [nested], mode: level % 2 === 0 ? 'screen' : 'overlay' });
        await client.execute({ type: 'setProperty', prop: { layer: nested, path: 'transform/opacity' }, value: { kind: 'scalar', value: 85 } });
        await client.execute({
          type: 'addKeyframes',
          keys: [
            { prop: { layer: nested, path: 'transform/position' }, time: 0, value: { kind: 'vec2', value: { x: 960 - 40, y: 540 - 20 } }, spatialIn: [], spatialOut: [], easing: 'linear' },
            { prop: { layer: nested, path: 'transform/position' }, time: secondsToFlicks(SECONDS), value: { kind: 'vec2', value: { x: 960 + 40, y: 540 + 20 } }, spatialIn: [], spatialOut: [], easing: 'linear' },
          ],
        });
        await addShapes(comp, level);
        inner = comp;
      }
      await client.execute({ type: 'setActiveComposition', comp: inner });
      console.log('[deep] ' + JSON.stringify({ step: 'build', wallMs: Number((performance.now() - t0).toFixed(0)), levels: DEPTH, shapesPerLevel: SHAPES }));
      await client.execute({
        type: 'setViewport',
        viewport: 1, width: 1920, height: 1080, devicePixelRatio: 1, zoom: 1,
        pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false,
        displayTransform: '', layerRenderEffects: true,
      });
      await client.execute({ type: 'setLoop', mode: 'once' });
      for (const resolution of ['full', 'half'] as const) {
        await client.execute({ type: 'setPreviewQuality', resolution, fastPreview: 'off', draft3d: false, motionBlur: true, adaptiveFloor: 'half' });
        frames.length = 0;
        phase = 'starting';
        await client.execute({
          type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: secondsToFlicks(SECONDS) },
          audio: false, cacheFirst: false, cacheOnly: false,
        });
        const until = Date.now() + 120_000;
        while (phase !== 'stopped' && Date.now() < until) await sleep(50);
        const stats = unwrap(await client.query({ type: 'getRenderStats' }));
        const gaps = frames.slice(1).map((f, i) => f.at - frames[i]!.at);
        const line = {
          resolution,
          frames: frames.length,
          dropped: frames.reduce((n, f) => n + f.dropped, 0),
          renderP50Ms: Number(pct(frames.map((f) => f.ms), 0.5).toFixed(2)),
          renderP95Ms: Number(pct(frames.map((f) => f.ms), 0.95).toFixed(2)),
          intervalP50Ms: Number(pct(gaps, 0.5).toFixed(1)),
          intervalP95Ms: Number(pct(gaps, 0.95).toFixed(1)),
          cpuFrameMs: Number(stats.cpuFrameMs.toFixed(2)),
          gpuFrameMs: Number(stats.gpuFrameMs.toFixed(2)),
          fps: Number(stats.fps.toFixed(1)),
        };
        console.log('[deep] ' + JSON.stringify(line));
        expect(phase).toBe('stopped');
        expect(frames.length).toBeGreaterThan(0);
        metrics.push(
          { name: SCENARIO, metric: `${resolution}.renderP50`, unit: 'ms', value: line.renderP50Ms, samples: frames.length },
          { name: SCENARIO, metric: `${resolution}.renderP95`, unit: 'ms', value: line.renderP95Ms, samples: frames.length },
          { name: SCENARIO, metric: `${resolution}.intervalP50`, unit: 'ms', value: line.intervalP50Ms, samples: gaps.length },
          { name: SCENARIO, metric: `${resolution}.dropped`, unit: 'count', value: line.dropped, samples: 0 },
        );
      }
    } finally {
      await native.stop();
      if (metrics.length > 0) recordBench(metrics);
    }
  }, 300_000);
});
