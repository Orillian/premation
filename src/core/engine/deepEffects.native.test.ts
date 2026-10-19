/**
 * Program X (docs/PROGRAM_DEEP_EFFECTS.md): the deep effects — multi-pass
 * `fx-graph` entries — rendered on the app's engine with the full renderer.
 * Every one must reach the GPU chain (no effect error on the layer) and change
 * the picture; each is also checked for what it means, not just that it moves
 * pixels.
 *
 * Needs a GPU adapter (PREMATION_GPU_TESTS=1).
 */

import { PNG } from 'pngjs';
import type { Command } from '@motion/engine-api';
import { activeCompRootId } from '@core/scene/activeComp';
import { runToolTurn } from '@core/ai/aiTurn';
import { documentMirror } from '@stores/documentMirror';
import { engineIdle } from '@core/engine/engineInstance';
import { sec, settleEdits, setupAppEngine, type Harness } from './__testHelpers__/appEngine';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

const suite = process.env.PREMATION_GPU_TESTS === '1' ? describe : describe.skip;
const W = 320;
const H = 180;

/**
 * Every deep effect (but the time effects, below), with settings that make it
 * act visibly on the test scene: its host layer (default the adjustment layer
 * over the scene), and the layers its layer controls name. `Plate` is a solid
 * with an ellipse mask (the effects that follow a mask path).
 */
interface Case { params: Record<string, unknown>; host?: string; layers?: Record<string, string> }
const EFFECTS: Record<string, Case> = {
  // Batch 1
  'lens-bloom': { params: { threshold: 50, intensity: 300, radius: 60 } },
  shine: { params: { threshold: 20, rayLength: 60, boostLight: 3 } },
  'image-flares': { params: { threshold: 90, intensity: 200 } },
  painterly: { params: { brushSize: 6 } },
  watercolor: { params: {} },
  'ink-outline': { params: {} },
  'detail-upscale': { params: { scale: 200 }, host: 'Box' },
  'paint-bucket': { params: { tolerance: 20 } },
  // Batch 2
  'light-wrap': { params: { wrapWidth: 20, intensity: 300 }, host: 'Plate', layers: { backgroundLayer: 'Box' } },
  refraction: { params: { depth: 40, heightSource: 1 }, host: 'Star' },
  'compound-arithmetic': { params: { operator: 4 }, layers: { secondLayer: 'Star' } },
  'color-link': { params: {}, host: 'Box', layers: { sourceLayer: 'Star' } },
  'inner-outer-key': { params: { highlightRadius: 12 }, host: 'KeyAdj' },
  'energy-saber': { params: { coreType: 1, glowIntensity: 200 }, host: 'Star' },
  // (Its maps are curves, which the AI tool does not pass; Phase cycles the identity map.)
  'ps-arbitrary-map': { params: { phase: 180 } },
  'edge-rays': { params: { rayLength: 60, intensity: 6, edgeSource: 1 } },
  // Batch 3 (the comp read as an equirectangular frame)
  'vr-blur': { params: { blurriness: 8 } },
  'vr-chromatic-aberrations': { params: { red: 40, blue: -40 } },
  'vr-converter': { params: { outputLayout: 1 } },
  'vr-denoise': { params: { noiseLevel: 80 } },
  'vr-fractal-noise': { params: {} },
  'vr-glow': { params: { threshold: 50, radius: 30, brightness: 300 } },
  'vr-plane-to-sphere': { params: { fov: 90 }, host: 'Box' },
  'vr-sharpen': { params: { amount: 400, radius: 3 } },
  // Batch 4 (the scene has a point light; the camera is AE's default)
  'volumetric-lights': { params: { density: 200, intensity: 400 } },
  relight: { params: { depth: 30 }, host: 'Box' },
  'volumetric-clouds': { params: { altitude: 300, coverage: 70, quality: 24 } },
  starfield: { params: { density: 150, brightness: 300 } },
  'cc-environment': { params: { reflectivity: 100 }, host: 'Box', layers: { environment: 'Star' } },
  ocean: { params: { seaLevel: 700 } },
  aurora: { params: { altitude: 200, intensity: 400 } },
  'stroke-3d': { params: { thickness: 6, repeater: true, instances: 3 }, host: 'Plate' },
};

suite('program X deep effects on the full renderer', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setupAppEngine({ gpu: true });
    await h.run({ type: 'setCompositionSettings', comp: activeCompRootId() as string, patch: { width: W, height: H, duration: sec(4) } } as Command);
    await h.run({ type: 'setViewport', viewport: 1, width: W, height: H, devicePixelRatio: 1, zoom: 0, pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true } as Command);
    await settleEdits();
  }, 60_000);
  afterAll(async () => { await h.dispose(); });

  async function clear(): Promise<void> {
    const m = documentMirror();
    const ids = m.layerIds().filter((id) => m.layer(id)?.comp === activeCompRootId());
    if (ids.length) await runToolTurn('AI: clear', [{ name: 'delete_layer', args: { nodeIds: ids } }]);
    await settleEdits();
  }
  async function frame(t = 1): Promise<PNG> {
    await settleEdits();
    const th = (await h.query({ type: 'getThumbnail', item: activeCompRootId() as string, time: sec(t), maxSize: W } as never)) as { data: Uint8Array };
    return PNG.sync.read(Buffer.from(th.data));
  }
  const px = (p: PNG, x: number, y: number): [number, number, number] => {
    const i = (Math.round(y * p.height / H) * p.width + Math.round(x * p.width / W)) * 4;
    return [p.data[i]!, p.data[i + 1]!, p.data[i + 2]!];
  };
  const lum = (c: [number, number, number]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const meanDiff = (a: PNG, b: PNG): number => {
    let s = 0;
    for (let i = 0; i < a.data.length; i += 4) s += Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!);
    return s / (a.data.length / 4) / 3;
  };
  const scene = [
    { name: 'create_layer', args: { id: 'bg', kind: 'solid', name: 'BG', x: W / 2, y: H / 2, width: W, height: H, fill: '#20243a' } },
    { name: 'create_layer', args: { id: 'star', kind: 'shape', shape: 'star', name: 'Star', x: 240, y: 70, width: 90, height: 90, points: 5, fill: '#ffe680' } },
    { name: 'create_layer', args: { id: 'box', kind: 'shape', shape: 'rect', name: 'Box', x: 90, y: 100, width: 100, height: 70, fill: '#f4f4f4' } },
  ];
  /** The layer of that name in the active composition (an earlier precomp may hold another). */
  const named = (name: string): string => {
    const m = documentMirror();
    return m.layerIds().find((id) => m.layer(id)?.name === name && m.layer(id)?.comp === activeCompRootId())!;
  };
  /** PREMATION_DUMP_DIR: every checked frame is written there as <name>.png (to look at them). */
  const dump = (name: string, p: PNG): void => {
    const dir = process.env.PREMATION_DUMP_DIR;
    if (dir) require('fs').writeFileSync(require('path').join(dir, `${name}.png`), PNG.sync.write(p));
  };
  async function withEffect(host: string, type: string, params: Record<string, unknown>): Promise<PNG> {
    const r = await runToolTurn(`AI: ${type}`, [{ name: 'add_effect', args: { nodeId: named(host), type, id: 'fx', params } }]);
    expect(r.results[0]!.ok).toBe(true);
    const f = await frame();
    dump(type, f);
    await runToolTurn('AI: remove', [{ name: 'update_effect', args: { nodeId: named(host), effectId: 'fx', remove: true } }]);
    return f;
  }

  it('every deep effect renders on the GPU chain and changes the picture', async () => {
    await clear();
    await runToolTurn('AI: scene', [
      ...scene,
      { name: 'create_layer', args: { id: 'plate', kind: 'solid', name: 'Plate', x: 160, y: 140, width: 120, height: 60, fill: '#3fa66b' } },
      { name: 'create_layer', args: { id: 'adj', kind: 'adjustment', name: 'Adj', x: W / 2, y: H / 2 } },
      { name: 'create_layer', args: { id: 'key', kind: 'light', name: 'Key' } },
      // Inner/Outer Key's plate: an adjustment layer masked around the box (white on navy).
      { name: 'create_layer', args: { id: 'keyadj', kind: 'adjustment', name: 'KeyAdj', x: W / 2, y: H / 2 } },
    ]);
    await runToolTurn('AI: mask', [
      { name: 'create_mask', args: { nodeId: named('Plate'), shape: 'ellipse', width: 90, height: 44 } },
      { name: 'create_mask', args: { nodeId: named('KeyAdj'), shape: 'rectangle', width: 140, height: 100, x: -70, y: 10 } },
    ]);
    const base = await frame();
    dump('base-all', base);
    const problems: string[] = [];
    for (const [type, c] of Object.entries(EFFECTS)) {
      const host = named(c.host ?? 'Adj');
      const params: Record<string, unknown> = { ...c.params };
      for (const [k, layerName] of Object.entries(c.layers ?? {})) params[k] = named(layerName);
      const r = await runToolTurn(`AI: ${type}`, [{ name: 'add_effect', args: { nodeId: host, type, id: 'fx', params } }]);
      if (!r.results[0]!.ok) problems.push(`${type}: ${r.results[0]!.content}`);
      const f = await frame();
      dump(`all-${type}`, f);
      await engineIdle();
      const errs = documentMirror().layerErrors(activeCompRootId() as string).filter((e) => e.stage !== 'font');
      if (errs.length) problems.push(`${type}: ${errs.map((e) => `${e.stage} ${e.message}`).join('; ')}`);
      if (meanDiff(base, f) < 0.05) problems.push(`${type}: no visible change`);
      await runToolTurn('AI: remove', [{ name: 'update_effect', args: { nodeId: host, effectId: 'fx', remove: true } }]);
    }
    expect(problems).toEqual([]);
  }, 600_000);

  it('Lens Bloom and Shine throw the star\'s light onto the dark ground around it', async () => {
    await clear();
    await runToolTurn('AI: scene', [...scene, { name: 'create_layer', args: { id: 'adj', kind: 'adjustment', name: 'Adj', x: W / 2, y: H / 2 } }]);
    const base = await frame();
    dump('base-bloom', base);
    // 18 px right of the star's right tip: dark ground in the base.
    const probe: [number, number] = [240 + 45 + 18, 66];
    const bloom = await withEffect('Adj', 'lens-bloom', { threshold: 50, intensity: 400, radius: 24 });
    expect(lum(px(bloom, ...probe))).toBeGreaterThan(lum(px(base, ...probe)) + 6);
    // Far from every highlight the ground stays (nearly) dark: a bloom, not a wash.
    expect(lum(px(bloom, 175, 170))).toBeLessThan(lum(px(base, 175, 170)) + 12);
    // Shine from the comp centre: rays stream AWAY from the source, so the far
    // side of the star (right of it) brightens more than the near side.
    const rays = await withEffect('Adj', 'shine', { threshold: 20, rayLength: 70, boostLight: 4, sourceX: 0, sourceY: 0, colorize: 0 });
    expect(lum(px(rays, 300, 60))).toBeGreaterThan(lum(px(base, 300, 60)) + 6);
  }, 300_000);

  it('Paint Bucket fills the connected region at its point and nothing beyond it', async () => {
    await clear();
    await runToolTurn('AI: scene', scene);
    const base = await frame();
    // On the box (a 100 x 70 white rect): the fill point is its centre.
    const filled = await withEffect('Box', 'paint-bucket', { tolerance: 10, color: '#e8352a' });
    const inside = px(filled, 90, 100);
    expect(inside[0]).toBeGreaterThan(180);
    expect(inside[1]).toBeLessThan(110);
    // The ground outside the box is untouched.
    expect(Math.abs(lum(px(filled, 10, 20)) - lum(px(base, 10, 20)))).toBeLessThan(3);
  }, 300_000);

  it('Detail-preserving Upscale grows the layer about its centre; Ink & Toon inks its edge', async () => {
    await clear();
    await runToolTurn('AI: scene', scene);
    const base = await frame();
    // The box spans x 40..140: at 200 % it reaches past x 150 on the right.
    const up = await withEffect('Box', 'detail-upscale', { scale: 200 });
    expect(lum(px(up, 150, 100))).toBeGreaterThan(lum(px(base, 150, 100)) + 60);
    await runToolTurn('AI: adj', [{ name: 'create_layer', args: { id: 'adj', kind: 'adjustment', name: 'Adj', x: W / 2, y: H / 2 } }]);
    const inked = await withEffect('Adj', 'ink-outline', { lineWeight: 1.5, lineColor: '#000000', fillOpacity: 100 });
    // XDoG inks the dark side of an edge: just outside the box's left edge
    // (x 40) the navy ground turns to black ink; the box's own white stays.
    const edge = Math.min(lum(px(inked, 36, 100)), lum(px(inked, 37, 100)), lum(px(inked, 38, 100)));
    expect(edge).toBeLessThan(lum(px(base, 37, 100)) - 10);
    expect(lum(px(inked, 90, 100))).toBeGreaterThan(200);
  }, 300_000);

  describe('the time effects (X1: the layer\'s content at other times)', () => {
    /** A precomp whose star crosses its frame (x 40 → 280 over 0..2 s): its CONTENT changes with time. */
    async function movingPrecomp(): Promise<string> {
      await clear();
      await runToolTurn('AI: scene', [
        { name: 'create_layer', args: { id: 'bg', kind: 'solid', name: 'BG', x: W / 2, y: H / 2, width: W, height: H, fill: '#141826' } },
        { name: 'create_layer', args: { id: 'star', kind: 'shape', shape: 'star', name: 'Star', x: 40, y: 90, width: 60, height: 60, points: 5, fill: '#ffe680' } },
      ]);
      await runToolTurn('AI: keys', [{ name: 'set_keyframes', args: { keyframes: [
        { nodeId: named('Star'), prop: 'x', t: 0, value: 40 }, { nodeId: named('Star'), prop: 'x', t: 2, value: 280 },
      ] } }]);
      const r = (await h.run({ type: 'precompose', comp: activeCompRootId() as string, layers: [named('Star')], name: 'Moving', mode: 'moveAll', adjustDuration: false } as Command)) as { layer: string };
      await settleEdits();
      return r.layer;
    }
    async function on(layer: string, type: string, params: Record<string, unknown>, t = 1): Promise<PNG> {
      const r = await runToolTurn(`AI: ${type}`, [{ name: 'add_effect', args: { nodeId: layer, type, id: 'fx', params } }]);
      expect(r.results[0]!.ok).toBe(true);
      const f = await frame(t);
      dump(`time-${type}`, f);
      await runToolTurn('AI: remove', [{ name: 'update_effect', args: { nodeId: layer, effectId: 'fx', remove: true } }]);
      return f;
    }

    it('every time effect reads the layer at other times and changes the picture', async () => {
      const layer = await movingPrecomp();
      const base = await frame(1);
      dump('time-base', base);
      const cases: Record<string, Record<string, unknown>> = {
        timewarp: { speed: 50 },
        'pixel-motion-blur': { shutterAngle: 360 },
        'time-displacement': { maxDisplacement: 0.4 },
        'time-difference': { timeOffset: -0.25 },
        'time-blend': { accumulation: 80, frameStep: 3 },
        'light-trails': { threshold: 30, trailLength: 16, intensity: 300 },
        datamosh: { holdTime: 0.5, intensity: 200 },
      };
      const problems: string[] = [];
      for (const [type, params] of Object.entries(cases)) {
        const f = await on(layer, type, params);
        await engineIdle();
        const errs = documentMirror().layerErrors(activeCompRootId() as string).filter((e) => e.stage !== 'font');
        if (errs.length) problems.push(`${type}: ${errs.map((e) => `${e.stage} ${e.message}`).join('; ')}`);
        if (meanDiff(base, f) < 0.05) problems.push(`${type}: no visible change`);
      }
      expect(problems).toEqual([]);
    }, 600_000);

    it('Timewarp at 50 % shows the star where it was at half the time; Time Difference lights both places', async () => {
      const layer = await movingPrecomp();
      // At t = 1 the star is at x 160; at 50 % speed the layer shows t = 0.5: x 100.
      const warped = await on(layer, 'timewarp', { speed: 50, method: 0 });
      expect(lum(px(warped, 100, 90))).toBeGreaterThan(150);
      expect(lum(px(warped, 160, 90))).toBeLessThan(60);
      // Now (x 160) against a quarter second earlier (x 130): both differ from each other.
      const diff = await on(layer, 'time-difference', { timeOffset: -0.25, absolute: true, alphaChannel: 4 });
      expect(lum(px(diff, 160, 90))).toBeGreaterThan(80);
      expect(lum(px(diff, 130, 90))).toBeGreaterThan(80);
      expect(lum(px(diff, 300, 20))).toBeLessThan(20);
    }, 300_000);
  });
});
