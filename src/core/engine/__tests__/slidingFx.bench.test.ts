/**
 * Effect-chain reuse for a layer that only moves (P8b, composition_pass.cpp
 * pixel_snap), on the GPU engine: a glowing title (glow + drop shadow +
 * blur) sliding across a 1080p30 frame with its whole reach on screen (a
 * result cut by the frame's edge is never moved), played uncached, each
 * scenario in a fresh engine. The chain runs in a buffer at the layer's exact sub-pixel
 * place and a kept result moves by whole pixels only — so a whole-pixel slide
 * reuses it on every frame, an eased slide (a new fraction each frame) runs
 * the chain, and a static layer on a half pixel reuses it (P8) while staying as
 * sharp as without effects.
 *
 * Run with the bench jest config — the default suite ignores `*.bench.test.ts`.
 */
import { ProcessEngineClient, secondsToFlicks, unwrap, type Command } from '@motion/engine-api';
import type { EngineFrameMessage } from '../../../../electron/engineFraming';
import { nativeEngineExe, startNativeEngine } from '../__testHelpers__/nativeEngine';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pct(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
}

const FPS = 30;

type Pos = { layer: string; path: string };
const vec = (x: number, y: number) => ({ kind: 'vec2' as const, value: { x, y } });
const SCENARIOS: Array<{ name: string; keys: (pos: Pos) => Command; glowKeyed?: boolean }> = [
  {
    // 600 px over 60 frames, linear: 10 px a frame, every frame on a whole pixel.
    name: 'whole-pixel slide',
    keys: (pos) => ({
      type: 'addKeyframes',
      keys: [
        { prop: pos, time: 0, value: vec(660, 540), spatialIn: [], spatialOut: [], easing: 'linear' },
        { prop: pos, time: secondsToFlicks(2), value: vec(1260, 540), spatialIn: [], spatialOut: [], easing: 'linear' },
      ],
    } as Command),
  },
  {
    // The same slide eased: a new sub-pixel fraction on every frame.
    name: 'eased slide',
    keys: (pos) => ({
      type: 'addKeyframes',
      keys: [
        { prop: pos, time: 0, value: vec(660, 540.3), spatialIn: [], spatialOut: [], easing: 'bezier', bezier: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 } },
        { prop: pos, time: secondsToFlicks(2), value: vec(1260, 540.3), spatialIn: [], spatialOut: [], easing: 'bezier', bezier: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 } },
      ],
    } as Command),
  },
  {
    name: 'static half pixel',
    keys: (pos) => ({ type: 'setProperty', prop: pos, value: vec(960.5, 540.5) } as Command),
  },
  {
    // The reference: a static title whose glow radius changes every frame runs its chain every frame.
    name: 'static, chain runs every frame',
    keys: (pos) => ({ type: 'setProperty', prop: pos, value: vec(960, 540) } as Command),
    glowKeyed: true,
  },
];

describe('a sliding glowing title reuses its effect chain', () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))('%s', async (_name, sc) => {
    if (!nativeEngineExe()) {
      console.log('[slidingFx] premation-engine is not built');
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
      const layer = process.env.SLIDE_SOLID
        ? unwrap(await client.execute({ type: 'createLayer', comp, kind: 'solid', name: 'Plate', init: [] })).layer
        : unwrap(await client.execute({
        type: 'createLayer', comp, kind: 'text', name: 'Title', init: [
          { path: 'text/sourceText', value: { kind: 'string', value: 'PREMATION' } },
          { path: 'text/fontSize', value: { kind: 'scalar', value: 120 } },
        ],
      })).layer;
      const scalar = (path: string, value: number) => ({ path, value: { kind: 'scalar' as const, value } });
      const glow = unwrap(await client.execute({ type: 'addEffect', layers: [layer], effect: 'glow', params: [] } as Command)) as unknown as { groups: string[] };
      await client.execute({ type: 'addEffect', layers: [layer], effect: 'drop-shadow', params: [] } as Command);
      await client.execute({ type: 'addEffect', layers: [layer], effect: 'gaussian-blur', params: [scalar('blurriness', 4)] } as Command);
      await client.execute(sc.keys({ layer, path: 'transform/position' }));
      if (sc.glowKeyed) {
        const prop = { layer, path: `${glow.groups[0]!}/radius` };
        await client.execute({
          type: 'addKeyframes',
          keys: [
            { prop, time: 0, value: { kind: 'scalar', value: 16 }, spatialIn: [], spatialOut: [], easing: 'linear' },
            { prop, time: secondsToFlicks(2), value: { kind: 'scalar', value: 22 }, spatialIn: [], spatialOut: [], easing: 'linear' },
          ],
        } as Command);
      }
      await client.execute({
        type: 'setViewport',
        viewport: 1, width: 1920, height: 1080, devicePixelRatio: 1, zoom: 1,
        // The comp fills the view (pan is the view's centre in comp px).
        pan: { x: 960, y: 540 }, channel: 'rgb', exposure: 0, transparencyGrid: false,
        displayTransform: '', layerRenderEffects: true,
      });
      await client.execute({ type: 'setLoop', mode: 'once' });
      // Twice: the first pass pays the pipelines and rasters; the second is measured.
      for (const pass of ['warm-up', 'measured'] as const) {
        frames.length = 0;
        phase = 'starting';
        await client.execute({
          type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: secondsToFlicks(2) },
          audio: false, cacheFirst: false, cacheOnly: false,
        });
        const until = Date.now() + 120_000;
        while (phase !== 'stopped' && Date.now() < until) await sleep(50);
        expect(phase).toBe('stopped');
        expect(frames.length).toBeGreaterThan(0);
        if (pass === 'warm-up') continue;
        const ms = frames.map((f) => f.ms);
        console.log('[slidingFx] ' + JSON.stringify({
          scenario: sc.name,
          frames: frames.length,
          dropped: frames.reduce((n, f) => n + f.dropped, 0),
          renderMeanMs: Number((ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(2)),
          renderP50Ms: Number(pct(ms, 0.5).toFixed(2)),
          renderP95Ms: Number(pct(ms, 0.95).toFixed(2)),
        }));
      }
      const errors = unwrap(await client.query({ type: 'getLayerErrors', comp })).errors.filter((e) => e.stage !== 'font');
      expect(errors).toEqual([]);
    } finally {
      await native.stop();
    }
  }, 300_000);
});
