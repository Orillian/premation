/**
 * What PLAYBACK shows of a simple 3D scene, frame by frame, against what the
 * same frame shows paused. A rotating cube, sphere and torus under a camera
 * move and a shadow-casting spot over a floor: every played frame's pixels
 * (route A, `copyFrames`) are compared with the frame drawn paused at the same
 * time. A frame that differs is a blink — an object missing, a stale chain or
 * shadow, a cached frame of another time.
 *
 * Three passes: paused seeks (the reference), playback with the frame cache
 * purged (every frame drawn while playing), playback again (frame-cache hits).
 *
 * Run with the bench jest config — the default suite ignores `*.bench.test.ts`.
 * Needs the full engine (GPU).
 */

import fs from 'node:fs';
import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { runToolTurn } from '@core/ai/aiTurn';
import { onSharedEnginePixels, sec, settleEdits, setupAppEngine, type Harness } from '../__testHelpers__/appEngine';
import { nativeEngineIsHeadless } from '../__testHelpers__/nativeEngine';
import { MAIN_VIEWPORT } from '@stores/overlayGeometry';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate', 'hrtime', 'performance', 'Date'] });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * FLICKER_SCENE: `lit` (default), `flat`, `rich`, or `big` — a heavy 3D comp
 * of forty stroked shape layers under a camera that pushes in close, with the
 * engine's raster cache pinned at 8 MB (PREMATION_RASTER_CACHE_MB, read when
 * it starts) so one frame's rasters outgrow it: the eviction found 2026-10-18,
 * where a frame evicted its own earlier layers while rasterising the later
 * ones, blinked objects and strokes out at exactly those frames.
 */
const scene = process.env.FLICKER_SCENE ?? 'lit';
if (scene === 'big') process.env.PREMATION_RASTER_CACHE_MB ??= '8';

const FPS = 30;
const SECONDS = 2;
const FRAMES = FPS * SECONDS;
const W = 640;
const H = 360;
/** The signature grid: each frame reduced to GW × GH mean-luma cells. */
const GW = 32;
const GH = 18;

function signature(data: Uint8Array, width: number, height: number, bytesPerRow: number): Float32Array {
  const out = new Float32Array(GW * GH);
  const counts = new Uint32Array(GW * GH);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(GH - 1, Math.floor((y * GH) / height));
    const row = y * bytesPerRow;
    for (let x = 0; x < width; x++) {
      const gx = Math.min(GW - 1, Math.floor((x * GW) / width));
      const i = row + x * 4;
      out[gy * GW + gx]! += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
      counts[gy * GW + gx]! += 1;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = counts[i] ? out[i]! / counts[i]! : 0;
  return out;
}

/** Debug: one frame as a binary PPM (FLICKER_DUMP=<folder>). */
function dumpPpm(file: string, px: { data: Uint8Array; width: number; height: number; bytesPerRow: number }): void {
  const head = Buffer.from(`P6
${px.width} ${px.height}
255
`);
  const body = Buffer.alloc(px.width * px.height * 3);
  for (let y = 0; y < px.height; y++) {
    for (let x = 0; x < px.width; x++) {
      const i = y * px.bytesPerRow + x * 4;
      const o = (y * px.width + x) * 3;
      body[o] = px.data[i]!;
      body[o + 1] = px.data[i + 1]!;
      body[o + 2] = px.data[i + 2]!;
    }
  }
  fs.writeFileSync(file, Buffer.concat([head, body]));
}

/** The largest per-cell luma difference between two signatures (0–255). */
function maxDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

describe('3D playback flicker', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setupAppEngine({ gpu: true, copyFrames: true });
  }, 60_000);
  afterAll(async () => { await h.dispose(); });

  it('every played frame matches the same frame paused', async () => {
    if (nativeEngineIsHeadless()) return;
    const comp = activeCompRootId() as string;
    await h.run({ type: 'setCompositionSettings', comp, patch: { width: 1280, height: 720, frameRate: { num: FPS, den: 1 }, duration: sec(SECONDS) } } as Command);
    const calls: { name: string; args: Record<string, unknown> }[] = [
      { name: 'create_layer', args: { id: 'cam', kind: 'camera', name: 'Cam' } },
      { name: 'create_layer', args: { id: 'cube', kind: 'primitive', primitive: 'cube', name: 'Cube', width: 200, height: 200, depth: 200, x: 400, y: 360, fill: '#d04a3a' } },
      { name: 'create_layer', args: { id: 'ball', kind: 'primitive', primitive: 'sphere', name: 'Ball', radius: 110, x: 760, y: 360, fill: '#3a8ad0' } },
      { name: 'create_layer', args: { id: 'ring', kind: 'primitive', primitive: 'torus', name: 'Ring', radius: 120, tube: 30, x: 1000, y: 360, fill: '#e0c040' } },
      { name: 'set_keyframes', args: { keyframes: [
        { nodeId: 'cube', prop: 'rotationY', t: 0, value: 0 }, { nodeId: 'cube', prop: 'rotationY', t: SECONDS, value: 180 },
        { nodeId: 'ring', prop: 'rotationX', t: 0, value: 0 }, { nodeId: 'ring', prop: 'rotationX', t: SECONDS, value: 180 },
        { nodeId: 'ball', prop: 'y', t: 0, value: 300 }, { nodeId: 'ball', prop: 'y', t: SECONDS, value: 420 },
        { nodeId: 'cam', prop: 'z', t: 0, value: -1600 }, { nodeId: 'cam', prop: 'z', t: SECONDS, value: -1300 },
      ] } },
    ];
    if (scene !== 'flat') {
      calls.push(
        { name: 'create_layer', args: { id: 'floor', kind: 'solid', name: 'Floor', width: 2400, height: 2400, fill: '#808080' } },
        { name: 'update_layer', args: { nodeId: 'floor', threeD: true, y: 520, rotationX: 90, acceptsShadows: true } },
        { name: 'create_layer', args: { id: 'key', kind: 'light', name: 'Key' } },
        { name: 'set_light', args: { nodeId: 'key', type: 'spot', intensity: 120, coneAngle: 80, castsShadows: true, shadowDiffusion: 20 } },
        { name: 'update_layer', args: { nodeId: 'key', x: 500, y: -200, z: -900 } },
        { name: 'create_layer', args: { id: 'amb', kind: 'light', name: 'Ambient' } },
        { name: 'set_light', args: { nodeId: 'amb', type: 'ambient', intensity: 30 } },
      );
      for (const id of ['cube', 'ball', 'ring']) calls.push({ name: 'update_layer', args: { nodeId: id, castsShadows: 'on' } });
    }
    if (scene === 'rich') {
      // The features a "simple" 3D scene grows into: extruded 3D type, an effect
      // on a 3D layer, motion blur, depth of field, a PBR material.
      calls.push(
        { name: 'create_layer', args: { id: 'title', kind: 'text', name: 'Title', text: 'PREMATION', x: 640, y: 180 } },
        { name: 'update_layer', args: { nodeId: 'title', fontSize: 110, fill: '#f0e8ff', threeD: true, z: -150, extrusionDepth: 30, bevelDepth: 4 } },
        { name: 'add_effect', args: { nodeId: 'title', type: 'glow', params: { radius: 24 } } },
        { name: 'set_keyframes', args: { keyframes: [
          { nodeId: 'title', prop: 'rotationY', t: 0, value: -25 }, { nodeId: 'title', prop: 'rotationY', t: SECONDS, value: 25 },
        ] } },
        { name: 'update_layer', args: { nodeId: 'ball', shading: 'pbr', metal: 80, roughness: 30 } },
        { name: 'update_layer', args: { nodeId: 'cam', dofStrength: 12, focusDistance: 1500, dofAperture: 40 } },
        { name: 'set_motion_blur', args: { enabled: true, shutterAngle: 180, samples: 8 } },
        { name: 'set_motion_blur', args: { nodeId: 'cube', enabled: true } },
        { name: 'set_motion_blur', args: { nodeId: 'ring', enabled: true } },
      );
    }
    if (scene === 'big') {
      // Forty stroked shapes in depth, each turning, and the camera pushing in
      // from 1600 to 350 px: every layer's raster follows its projected size,
      // so the frame's rasters grow past the pinned budget towards the end.
      const shapes = ['rect', 'ellipse', 'polygon', 'star'] as const;
      const palette = ['#e05a3a', '#3a8ad0', '#e0c040', '#60c080', '#c060d0', '#f0f0f0'];
      for (let i = 0; i < 40; i++) {
        const id = `shape${i}`;
        const col = i % 8;
        const row = Math.floor(i / 8);
        calls.push(
          { name: 'create_layer', args: {
            id, kind: 'shape', shape: shapes[i % shapes.length], name: id, width: 180, height: 180,
            x: 240 + col * 115, y: 200 + row * 170, fill: palette[i % palette.length], stroke: '#101010', strokeWidth: 6,
          } },
          { name: 'update_layer', args: { nodeId: id, threeD: true, z: -200 + (i % 5) * 120 } },
          { name: 'set_keyframes', args: { keyframes: [
            { nodeId: id, prop: 'rotationY', t: 0, value: 0 }, { nodeId: id, prop: 'rotationY', t: SECONDS, value: (i % 2 ? 1 : -1) * 90 },
            { nodeId: id, prop: 'rotation', t: 0, value: 0 }, { nodeId: id, prop: 'rotation', t: SECONDS, value: 45 },
          ] } },
        );
      }
      calls.push(
        { name: 'create_layer', args: { id: 'bigTitle', kind: 'text', name: 'Title', text: 'BIG MOTION', x: 640, y: 120, fill: '#ffffff', stroke: '#2040a0', strokeWidth: 4 } },
        { name: 'update_layer', args: { nodeId: 'bigTitle', fontSize: 96 } },
        { name: 'update_layer', args: { nodeId: 'bigTitle', threeD: true, z: -300, extrusionDepth: 20 } },
        { name: 'remove_keyframes', args: { targets: [{ nodeId: 'cam', prop: 'z' }] } },
        { name: 'set_keyframes', args: { keyframes: [
          { nodeId: 'cam', prop: 'z', t: 0, value: -1600 }, { nodeId: 'cam', prop: 'z', t: SECONDS, value: -350 },
        ] } },
      );
    }
    const r = await runToolTurn('flicker: 3d scene', calls);
    const failed = r.results.filter((x) => !x.ok).map((x) => x.content);
    if (failed.length) console.log(`[flicker3d] tool failures ${JSON.stringify(failed.slice(0, 5))}`);
    await settleEdits();
    await h.run({
      type: 'setViewport', viewport: MAIN_VIEWPORT, width: W, height: H, devicePixelRatio: 1, zoom: 0, pan: { x: 0, y: 0 },
      channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true, view: 'active',
    } as Command);

    let phase = 'idle';
    let stats: unknown = null;
    const unsub = h.client.subscribe((b) => {
      for (const e of b.events) {
        if (e.type === 'transportChanged') phase = e.state;
        if (e.type === 'renderStatsUpdated') stats = e.stats;
      }
    });
    // The pixels are kept as they arrive and reduced after each pass: hashing
    // them in the listener would hold up the slot release and drop frames.
    type Raw = { frame: number; px: { data: Uint8Array; width: number; height: number; bytesPerRow: number }; ms: number; dropped: number; playing: boolean };
    let raws: Raw[] | null = null;
    const off = onSharedEnginePixels((ready, px) => {
      // Frames of the harness's first (1920×1080) ring may still land after the resize: not this viewport's.
      if (px.width !== W || px.height !== H) return;
      raws?.push({ frame: ready.frame, px, ms: (ready.renderDoneUs - ready.renderStartUs) / 1000, dropped: ready.dropped, playing: phase === 'playing' });
    });
    const sigOf = (r: Raw): Float32Array => signature(r.px.data, r.px.width, r.px.height, r.px.bytesPerRow);

    // Reference: each frame paused (seek, then the frame that lands for it).
    const reference = new Map<number, Float32Array>();
    const firstDraws: number[] = [];
    for (let f = 0; f < FRAMES; f++) {
      raws = [];
      await h.run({ type: 'seek', time: sec(f / FPS), mode: 'exact' } as Command);
      const until = Date.now() + 5000;
      // The paused frame may be drawn twice (a stand-in, then the settled one): take the last within a beat.
      while (Date.now() < until && !raws.some((r) => r.frame === f)) await sleep(5);
      await sleep(40);
      const mine = raws.filter((r) => r.frame === f);
      if (f === 0) for (const r of mine) firstDraws.push(Math.round(sigOf(r).reduce((a, b) => a + b, 0) / (GW * GH)));
      if (f === 0 && process.env.FLICKER_DUMP) mine.forEach((r, i) => dumpPpm(`${process.env.FLICKER_DUMP}/first-${i}.ppm`, r.px));
      if (mine.length) reference.set(f, sigOf(mine[mine.length - 1]!));
    }
    raws = null;

    const pass = async (label: string, purge: boolean): Promise<{ label: string; frames: number; blinks: Array<{ frame: number; diff: number }>; order: string; dropped: number; stats: unknown; p50ms: number }> => {
      if (purge) await h.run({ type: 'purgeCache', kind: 'all' } as Command);
      raws = [];
      await h.run({ type: 'setLoop', mode: 'once' } as Command);
      await h.run({ type: 'play', rate: 1, range: 'custom', custom: { start: 0, duration: sec(SECONDS) }, audio: false, cacheFirst: false, cacheOnly: false } as Command);
      await sleep(100);
      const until = Date.now() + 60_000;
      while (phase !== 'stopped' && Date.now() < until) await sleep(10);
      await sleep(200);
      const got = raws.filter((r) => r.playing);
      raws = null;
      let dropped = 0;
      const seen: Array<{ frame: number; diff: number; ms: number }> = [];
      for (const r of got) {
        dropped += r.dropped;
        const ref = reference.get(r.frame);
        if (ref) seen.push({ frame: r.frame, diff: maxDiff(ref, sigOf(r)), ms: r.ms });
      }
      const ms = seen.map((s) => s.ms).sort((a, b) => a - b);
      return {
        label,
        frames: seen.length,
        blinks: seen.filter((s) => s.diff > 24).map(({ frame, diff }) => ({ frame, diff: Math.round(diff) })),
        order: seen.map((s) => s.frame).join(','),
        dropped,
        stats,
        p50ms: Number((ms[Math.floor(ms.length / 2)] ?? 0).toFixed(2)),
      };
    };
    const cold = await pass('cold', true);
    const warm = await pass('cached', false);
    const cold2 = await pass('cold-again', true);
    // Frame 0 paused again, now that everything has drawn once.
    await h.run({ type: 'seek', time: sec(1), mode: 'exact' } as Command);
    await sleep(300);
    raws = [];
    await h.run({ type: 'seek', time: 0, mode: 'exact' } as Command);
    await sleep(500);
    const last0 = raws.filter((r) => r.frame === 0).pop();
    const again = last0 ? { sig: sigOf(last0) } : null;
    if (last0 && process.env.FLICKER_DUMP) dumpPpm(`${process.env.FLICKER_DUMP}/again.ppm`, last0.px);
    raws = null;
    off();
    unsub();
    const mean = (sig?: Float32Array): number => (sig ? Math.round(sig.reduce((a, b) => a + b, 0) / sig.length) : -1);
    console.log(`[flicker3d] ${JSON.stringify({ scene, reference: reference.size, refMeans: [0, 1, 2, 30, 59].map((f) => mean(reference.get(f))), frame0Again: mean(again?.sig), firstDraws, cold, warm, cold2 })}`);
    expect(reference.size).toBeGreaterThan(FRAMES * 0.9);
    expect(cold.blinks).toEqual([]);
    expect(warm.blinks).toEqual([]);
    expect(cold2.blinks).toEqual([]);
  }, 300_000);
});
