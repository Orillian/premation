/**
 * Edit latency on a huge comp: 3000 rectangle layers on a 2-second 30 fps
 * 1080p comp, the playhead parked mid-way, then 20 single-property edits
 * (setProperty transform/position on one layer each) — what a drag on one
 * layer of a very busy comp feels like. For every edit the time from sending
 * the command to the next frameReady that shows the written revision is
 * taken, and one `[edit] {json}` line reports p50 / p95 / max with the
 * command round trip (the engine's own turnaround) and the draw time apart.
 *
 * Recorded for the ratchet as `editLatency/3000layers-1080p`.
 *
 *   PREMATION_BENCH_LAYERS=<n>   layer count (default 3000)
 *   PREMATION_BENCH_EDITS=<n>    edits timed (default 20)
 *
 * The layers are made 100 at a time and then duplicated in rounds
 * (duplicateLayers) — a single createLayer per layer is what makes the
 * build long, not what this bench measures. Run with the bench jest config —
 * the default suite ignores `*.bench.test.ts`.
 */
import { ProcessEngineClient, secondsToFlicks, unwrap } from '@motion/engine-api';
import type { EngineFrameMessage } from '../../../../electron/engineFraming';
import { recordBench } from '../../perf/bench/benchRecord';
import { nativeEngineExe, startNativeEngine } from '../__testHelpers__/nativeEngine';

type FrameReady = Extract<EngineFrameMessage, { type: 'frameReady' }>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pct(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
}

const LAYERS = Number(process.env.PREMATION_BENCH_LAYERS ?? '3000');
const EDITS = Number(process.env.PREMATION_BENCH_EDITS ?? '20');
const FPS = 30;
const SECONDS = 2;
const SEED = 100;
const SCENARIO = `editLatency/${LAYERS}layers-1080p`;

describe('edit latency: one property edit on a 3000-layer comp', () => {
  it(`times ${EDITS} edits from the command to the next frameReady`, async () => {
    if (!nativeEngineExe()) {
      console.log('[edit] premation-engine is not built');
      return;
    }
    const native = await startNativeEngine({ extraArgs: ['--log-level', 'warn'] });
    const client = new ProcessEngineClient(native.bridge);
    const waiters = new Set<(m: FrameReady) => void>();
    native.supervisor.on('frame', (m: EngineFrameMessage) => {
      if (m.type !== 'frameReady') return;
      native.supervisor.releaseSlot(m.generation, m.slot);
      for (const w of [...waiters]) w(m);
    });
    const nextFrame = (pred: (m: FrameReady) => boolean, timeoutMs = 120_000): Promise<FrameReady | null> =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(on);
          resolve(null);
        }, timeoutMs);
        const on = (m: FrameReady): void => {
          if (!pred(m)) return;
          clearTimeout(timer);
          waiters.delete(on);
          resolve(m);
        };
        waiters.add(on);
      });
    const metrics: Parameters<typeof recordBench>[0] = [];
    try {
      // ── the comp: 100 placed rectangles, duplicated up to the count ───────
      const t0 = performance.now();
      await client.execute({ type: 'newProject' });
      const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
      const comp = doc.comps[0]!.id;
      await client.execute({
        type: 'setCompositionSettings',
        comp,
        patch: { frameRate: { num: FPS, den: 1 }, duration: secondsToFlicks(SECONDS), width: 1920, height: 1080 },
      });
      await client.execute({ type: 'setActiveComposition', comp });
      let layers: string[] = [];
      for (let i = 0; i < Math.min(SEED, LAYERS); i++) {
        const x = 80 + (i % 20) * 92;
        const y = 120 + Math.floor(i / 20) * 180;
        layers.push(unwrap(await client.execute({
          type: 'createLayer', comp, kind: 'rectangle', name: `R${i}`,
          init: [
            { path: 'transform/position', value: { kind: 'vec2', value: { x, y } } },
            { path: 'transform/scale', value: { kind: 'vec2', value: { x: 40, y: 40 } } },
          ],
        })).layer);
      }
      while (layers.length < LAYERS) {
        const batch = layers.slice(0, Math.min(500, LAYERS - layers.length));
        layers = layers.concat(unwrap(await client.execute({ type: 'duplicateLayers', layers: batch })).layers);
      }
      const buildMs = performance.now() - t0;
      console.log('[edit] ' + JSON.stringify({ step: 'build', wallMs: Number(buildMs.toFixed(0)), layers: layers.length }));
      expect(layers.length).toBe(LAYERS);

      // ── the viewport, parked at 1 s ───────────────────────────────────────
      const firstGot = nextFrame(() => true);
      await client.execute({
        type: 'setViewport',
        viewport: 1, width: 1920, height: 1080, devicePixelRatio: 1, zoom: 1,
        pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false,
        displayTransform: '', layerRenderEffects: true,
      });
      await client.execute({ type: 'setPreviewQuality', resolution: 'full', fastPreview: 'off', draft3d: false, motionBlur: false, adaptiveFloor: 'full' });
      expect(await firstGot).not.toBeNull();
      const frame = FPS;
      const parked = nextFrame((m) => m.frame === frame);
      await client.execute({ type: 'seek', time: secondsToFlicks(1), mode: 'exact' });
      expect(await parked).not.toBeNull();
      await sleep(300);

      // ── the edits ─────────────────────────────────────────────────────────
      const wall: number[] = [];
      const command: number[] = [];
      const draw: number[] = [];
      for (let k = 0; k < EDITS; k++) {
        const layer = layers[Math.floor((k * layers.length) / EDITS)]!;
        const x = 200 + k * 60;
        const y = 300 + (k % 5) * 90;
        let written = -1;
        const redrawn = nextFrame((m) => m.frame === frame && Number(m.revision) >= written && written >= 0);
        const te = performance.now();
        const res = await client.execute({ type: 'setProperty', prop: { layer, path: 'transform/position' }, value: { kind: 'vec2', value: { x, y } } });
        unwrap(res);
        written = Number(res.revision);
        command.push(performance.now() - te);
        const m = await redrawn;
        wall.push(performance.now() - te);
        if (m) draw.push((m.renderDoneUs - m.renderStartUs) / 1000);
        expect(m).not.toBeNull();
        await sleep(50);
      }
      const stats = unwrap(await client.query({ type: 'getRenderStats' }));
      const line = {
        step: 'edits',
        edits: wall.length,
        p50Ms: Number(pct(wall, 0.5).toFixed(1)),
        p95Ms: Number(pct(wall, 0.95).toFixed(1)),
        maxMs: Number(Math.max(...wall).toFixed(1)),
        commandP50Ms: Number(pct(command, 0.5).toFixed(1)),
        drawP50Ms: Number(pct(draw, 0.5).toFixed(2)),
        buildMs: Number(stats.cpuFrameMs.toFixed(1)),
      };
      console.log('[edit] ' + JSON.stringify(line));
      metrics.push(
        { name: SCENARIO, metric: 'build.wall', unit: 'ms', value: Number(buildMs.toFixed(1)), samples: 1 },
        { name: SCENARIO, metric: 'edit.p50', unit: 'ms', value: line.p50Ms, samples: wall.length },
        { name: SCENARIO, metric: 'edit.p95', unit: 'ms', value: line.p95Ms, samples: wall.length },
        { name: SCENARIO, metric: 'edit.commandP50', unit: 'ms', value: line.commandP50Ms, samples: command.length },
      );
    } finally {
      await native.stop();
      if (metrics.length > 0) recordBench(metrics);
    }
  }, 300_000);
});
