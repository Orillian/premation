/**
 * The preview cache across view changes, on the GPU engine
 * (native/engine/src/core/frame_scene.hpp comp_space_frame, Session::idle_prefetch,
 * render/ram_cache.hpp ProtectedRange::pinned):
 *
 *   1. Comp-space keys: a cached frame survives a pane resize and a whole-pixel
 *      pan — the bar stays full and a played pass is served from the cache,
 *      not drawn. A zoom is other pixels and starts over.
 *   2. Idle render-ahead: with the transport stopped, the frames ahead of the
 *      playhead reach the cache on their own, and the playhead never moves.
 *   3. Per-view protection: a fill for the comp viewport, into a cache too
 *      small for it, never evicts the frame a second surface (a Layer view)
 *      shows — that view keeps hitting the cache instead of redrawing.
 *
 * Needs a GPU adapter (PREMATION_GPU_TESTS=1), like the other full-renderer suites.
 */

import { ProcessEngineClient, secondsToFlicks, unwrap } from '@motion/engine-api';
import type { EngineFrameMessage } from '../../../electron/engineFraming';
import { nativeEngineExe, startNativeEngine } from './__testHelpers__/nativeEngine';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const suite = process.env.PREMATION_GPU_TESTS === '1' && nativeEngineExe() ? describe : describe.skip;

const FPS = 30;
const SECONDS = 2;
const FRAMES = FPS * SECONDS;
const FRAME = secondsToFlicks(1 / FPS);
const frameCount = (ranges: ReadonlyArray<{ start: number; end: number }>): number =>
  ranges.reduce((n, r) => n + Math.round((r.end - r.start) / FRAME), 0);
const covers = (ranges: ReadonlyArray<{ start: number; end: number }>, frame: number): boolean =>
  ranges.some((r) => frame * FRAME >= r.start && frame * FRAME < r.end);

interface Scene {
  client: ProcessEngineClient;
  comp: string;
  layers: string[];
  phase: () => string;
  untilStopped: () => Promise<void>;
  coverage: () => Promise<{ ram: { start: number; end: number }[]; disk: { start: number; end: number }[] }>;
}

async function animatedScene(client: ProcessEngineClient): Promise<Scene> {
  let phase = 'idle';
  client.subscribe((batch) => {
    for (const e of batch.events) if (e.type === 'transportChanged') phase = e.state;
  });
  await client.execute({ type: 'newProject' });
  const doc = unwrap(await client.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false }));
  const comp = doc.comps[0]!.id;
  await client.execute({ type: 'setCompositionSettings', comp, patch: { frameRate: { num: FPS, den: 1 }, duration: secondsToFlicks(SECONDS), width: 640, height: 360 } });
  await client.execute({ type: 'setActiveComposition', comp });
  const layers: string[] = [];
  for (let i = 0; i < 4; i++) {
    const layer = unwrap(await client.execute({ type: 'createLayer', comp, kind: 'rectangle', name: `R${i}`, init: [] })).layer;
    layers.push(layer);
    const x = 80 + i * 120;
    await client.execute({
      type: 'addKeyframes',
      keys: [
        { prop: { layer, path: 'transform/position' }, time: 0, value: { kind: 'vec2', value: { x, y: 80 } }, spatialIn: [], spatialOut: [], easing: 'linear' },
        { prop: { layer, path: 'transform/position' }, time: secondsToFlicks(SECONDS), value: { kind: 'vec2', value: { x: x + 40, y: 280 } }, spatialIn: [], spatialOut: [], easing: 'linear' },
      ],
    });
  }
  await client.execute({ type: 'setLoop', mode: 'once' });
  return {
    client,
    comp,
    layers,
    phase: () => phase,
    untilStopped: async () => {
      const until = Date.now() + 60_000;
      await sleep(200);
      while (phase !== 'stopped' && Date.now() < until) await sleep(25);
      expect(phase).toBe('stopped');
    },
    coverage: async () => unwrap(await client.query({ type: 'getCacheCoverage', comp })),
  };
}

/** The comp viewport: `width` × `height` CSS px at `zoom`, the comp point `pan` at its centre. */
const viewport = (client: ProcessEngineClient, id: number, width: number, height: number, zoom: number, pan: { x: number; y: number }) =>
  client.execute({
    type: 'setViewport', viewport: id, width, height, devicePixelRatio: 1, zoom, pan,
    channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true,
  });

suite('comp-space cache keys', () => {
  it('a pane resize and a whole-pixel pan keep every cached frame; a zoom starts over', async () => {
    // Idle render-ahead off: this test measures what playback alone cached.
    const native = await startNativeEngine({ extraArgs: ['--frame-cache-mb', '256', '--ram-cache-mb', '512', '--log-level', 'warn'] }, { PREMATION_IDLE_PREFETCH: '0' });
    const client = new ProcessEngineClient(native.bridge);
    native.supervisor.on('frame', (m: EngineFrameMessage) => {
      if (m.type === 'frameReady') native.supervisor.releaseSlot(m.generation, m.slot);
    });
    try {
      const s = await animatedScene(client);
      // The comp fills a 640×360 pane at 100 %: its centre (320, 180) at the pane's centre.
      await viewport(client, 1, 640, 360, 1, { x: 320, y: 180 });
      await sleep(300);
      await client.execute({ type: 'play', rate: 1, range: 'all', audio: false, cacheFirst: true, cacheOnly: true });
      await s.untilStopped();
      await sleep(300);
      expect(frameCount((await s.coverage()).ram)).toBeGreaterThanOrEqual(FRAMES - 1);

      // Before comp-space keys, this resize emptied the bar and the next pass built every frame.
      await viewport(client, 1, 900, 500, 1, { x: 320, y: 180 });
      await sleep(400);
      const resized = await s.coverage();
      expect(frameCount(resized.ram)).toBeGreaterThanOrEqual(FRAMES - 1);
      const before = unwrap(await client.query({ type: 'getRenderStats' }));
      await client.execute({ type: 'seek', time: 0, mode: 'exact' });
      await client.execute({ type: 'play', rate: 1, range: 'all', audio: false, cacheFirst: false, cacheOnly: false });
      await s.untilStopped();
      const stats = unwrap(await client.query({ type: 'getRenderStats' }));
      console.log(`[compSpaceCache] after resize: cacheHitRate=${stats.cacheHitRate.toFixed(3)} cpuFrameMs=${stats.cpuFrameMs.toFixed(2)} (was ${before.cpuFrameMs.toFixed(2)} before the pass)`);
      expect(stats.cacheHitRate).toBeGreaterThan(0.9);

      // A pan by whole pixels: the same frames.
      await viewport(client, 1, 900, 500, 1, { x: 300, y: 170 });
      await sleep(400);
      expect(frameCount((await s.coverage()).ram)).toBeGreaterThanOrEqual(FRAMES - 1);

      // A zoom is other pixels: the bar holds the zoomed frames drawn since (the playhead's), not the old pass.
      await viewport(client, 1, 900, 500, 0.5, { x: 320, y: 180 });
      await sleep(400);
      expect(frameCount((await s.coverage()).ram)).toBeLessThanOrEqual(2);
      // And back: the first zoom's frames are still cached.
      await viewport(client, 1, 900, 500, 1, { x: 320, y: 180 });
      await sleep(400);
      expect(frameCount((await s.coverage()).ram)).toBeGreaterThanOrEqual(FRAMES - 1);
    } finally {
      await native.stop();
    }
  }, 180_000);
});

suite('idle render-ahead', () => {
  it('a stopped transport caches the frames ahead of the playhead without moving it', async () => {
    const native = await startNativeEngine({ extraArgs: ['--frame-cache-mb', '256', '--ram-cache-mb', '512', '--log-level', 'warn'] });
    const client = new ProcessEngineClient(native.bridge);
    const shown: number[] = [];
    native.supervisor.on('frame', (m: EngineFrameMessage) => {
      if (m.type === 'frameReady') {
        shown.push(m.frame);
        native.supervisor.releaseSlot(m.generation, m.slot);
      }
    });
    let playhead = -1;
    client.subscribe((batch) => {
      for (const e of batch.events) if (e.type === 'playhead') playhead = e.time;
    });
    try {
      const s = await animatedScene(client);
      await viewport(client, 1, 640, 360, 1, { x: 320, y: 180 });
      await client.execute({ type: 'seek', time: 10 * FRAME, mode: 'exact' });
      await sleep(300);
      const shownBefore = shown.length;
      // An edit, then quiet: the prefetcher starts after ~300 ms and takes one frame at a time.
      await client.execute({ type: 'setProperty', prop: { layer: s.layers[0]!, path: 'transform/opacity' }, value: { kind: 'scalar', value: 80 } });
      await sleep(1500);
      const cov = await s.coverage();
      const ahead = [11, 12, 13, 14, 15].filter((f) => covers(cov.ram, f)).length;
      console.log(`[idlePrefetch] 1.5 s after an edit: ${frameCount(cov.ram)} frames cached, ${ahead}/5 of the next five`);
      expect(ahead).toBeGreaterThanOrEqual(4);
      // The playhead stayed, and only the edit's own frame was presented.
      expect(playhead).toBe(10 * FRAME);
      expect(shown.length - shownBefore).toBeLessThanOrEqual(2);
      for (const f of shown.slice(shownBefore)) expect(f).toBe(10);
      // The frames it stored play back without a build.
      await client.execute({ type: 'play', rate: 1, range: 'all', audio: false, cacheFirst: false, cacheOnly: false });
      await s.untilStopped();
      const stats = unwrap(await client.query({ type: 'getRenderStats' }));
      expect(stats.cacheHitRate).toBeGreaterThan(0.5);
    } finally {
      await native.stop();
    }
  }, 120_000);
});

suite('per-view cache protection', () => {
  it('a fill for the comp view never evicts the frame a Layer view shows', async () => {
    // VRAM: two 640×360 frames (921 KB each); RAM: two more. A 60-frame fill
    // churns both tiers; the Layer view's one frame must stay a hit throughout.
    const native = await startNativeEngine({ extraArgs: ['--frame-cache-mb', '2', '--ram-cache-mb', '2', '--log-level', 'warn'] }, { PREMATION_IDLE_PREFETCH: '0' });
    const client = new ProcessEngineClient(native.bridge);
    let layerFrames = 0;
    native.supervisor.on('frame', (m: EngineFrameMessage) => {
      if (m.type === 'frameReady') {
        if (m.viewport === 2) layerFrames++;
        native.supervisor.releaseSlot(m.generation, m.slot);
      }
    });
    try {
      const s = await animatedScene(client);
      await viewport(client, 1, 640, 360, 1, { x: 320, y: 180 });
      // The Layer panel on R0 at a held time: its own picture, drawn once, then a cache hit per redraw.
      await client.execute({
        type: 'setViewport', viewport: 2, width: 640, height: 360, devicePixelRatio: 1, zoom: 1, pan: { x: 320, y: 180 },
        channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layer: s.layers[0]!, layerRenderEffects: true,
        time: 5 * FRAME,
      });
      await sleep(500);
      // A real-time pass (2 s: the stats window closes twice meanwhile) draws
      // FRAMES comp frames into the tiers; the Layer view redraws its held frame
      // with each. Pinned, those redraws are hits: about half of all frames.
      // Unpinned (before), every comp frame stored evicted it and the rate stayed near 0.
      await client.execute({ type: 'play', rate: 1, range: 'all', audio: false, cacheFirst: false, cacheOnly: false });
      await s.untilStopped();
      const stats = unwrap(await client.query({ type: 'getRenderStats' }));
      console.log(`[viewPins] play with a 2-frame cache: cacheHitRate=${stats.cacheHitRate.toFixed(3)} layer-view frames=${layerFrames}`);
      expect(layerFrames).toBeGreaterThan(FRAMES / 2);
      expect(stats.cacheHitRate).toBeGreaterThan(0.3);
    } finally {
      await native.stop();
    }
  }, 120_000);
});
