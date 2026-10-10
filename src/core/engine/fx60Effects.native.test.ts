/**
 * Program E (docs/PROGRAM_PERFORMANCE.md): the sixty effects added 2026-10-10
 * — After Effects' built-ins Premation lacked and the looks AE users reach for
 * most — rendered on the app's engine with the full renderer. Every one must
 * reach the GPU chain (no effect error on the layer) and change the picture;
 * a few are checked for what they mean, not just that they move pixels.
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

/** The sixty, with the settings that make each visibly act on the test scene. */
const EFFECTS: Record<string, Record<string, unknown>> = {
  'brightness-contrast': { brightness: 60 }, 'color-balance-hls': { hue: 120 }, calculations: { invertInput: true },
  'set-channels': { setRed: 2, setBlue: 0 }, blend: { mode: 0 }, 'difference-matte': { tolerance: 100 },
  'color-neutralizer': { midtonesUnbalance: '#a06040' }, blobbylize: {}, 'cc-split-2': { split1: 30 },
  'eyedropper-fill': {}, 'noise-hls-auto': {}, caustics: {}, shatter: { startTime: 0.2 }, 'wave-world': {},
  warpomatic: { completion: 40 }, overbrights: { dim: 50 }, 'hdr-compander': { gain: 2 }, 'hdr-highlight-compression': {},
  'reduce-interlace-flicker': { softness: 4 }, 'basic-3d': { swivel: 35 }, 'digital-glitch': { amount: 80 },
  'vr-rotate-sphere': { pan: 60 }, 'color-gradients': {}, vhs: {}, crt: {}, 'pixel-sort': {}, 'long-shadow': {},
  halation: { threshold: 20 }, 'light-leaks': {}, 'tilt-shift': { focusWidth: 20, transition: 20 }, 'gradient-map': {},
  duotone: {}, 'soft-glow': {}, neon: {}, hologram: {}, dither: {}, ascii: {}, 'led-screen': {}, 'pencil-sketch': {},
  'oil-paint': { brushSize: 6 }, 'camera-shake': { amount: 20 }, flicker: { amount: 80 }, prism: {}, 'frosted-glass': {},
  'bleach-bypass': {}, 'cross-process': {}, 'split-toning': { highlightSaturation: 80, shadowSaturation: 80 },
  'old-film': {}, 'anamorphic-streaks': { threshold: 20 }, starglow: { threshold: 20 }, sparkle: { density: 100, threshold: 10 },
  'white-balance': { temperature: 60 }, clarity: { amount: 100, radius: 8 }, 'lens-distortion': {}, 'heat-haze': { amount: 10, scale: 20 },
  'color-halftone': {}, crystallize: {}, fog: { density: 90 }, chrome: {}, 'night-vision': {},
};
/** Effects that act on a layer's own shape (its alpha): they go on the box; the rest on an adjustment layer over the scene. */
const ON_LAYER = new Set(['long-shadow', 'neon', 'blobbylize', 'chrome', 'cc-split-2', 'basic-3d', 'shatter', 'halation', 'starglow',
  'anamorphic-streaks', 'prism', 'calculations', 'set-channels', 'blend', 'difference-matte', 'sparkle']);
/** Effects whose layer reference is set to the star (the four that read another layer). */
const LAYER_PARAM: Record<string, string> = {
  calculations: 'secondLayer', 'set-channels': 'sourceLayer', blend: 'blendLayer', 'difference-matte': 'differenceLayer',
};

suite('program E effects on the full renderer', () => {
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
  const meanDiff = (a: PNG, b: PNG): number => {
    let s = 0;
    for (let i = 0; i < a.data.length; i += 4) s += Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!);
    return s / (a.data.length / 4) / 3;
  };
  const scene = [
    { name: 'create_layer', args: { id: 'bg', kind: 'solid', name: 'BG', x: W / 2, y: H / 2, width: W, height: H, fill: '#6a5acd' } },
    { name: 'create_layer', args: { id: 'star', kind: 'shape', shape: 'star', name: 'Star', x: 240, y: 70, width: 90, height: 90, points: 5, fill: '#ffcf33' } },
    { name: 'create_layer', args: { id: 'box', kind: 'shape', shape: 'rect', name: 'Box', x: 90, y: 100, width: 100, height: 70, fill: '#f4f4f4' } },
  ];
  const named = (name: string): string => documentMirror().layerIds().find((id) => documentMirror().layer(id)?.name === name)!;

  it('every one of the sixty renders on the GPU chain and changes the picture', async () => {
    await clear();
    await runToolTurn('AI: scene', [...scene, { name: 'create_layer', args: { id: 'adj', kind: 'adjustment', name: 'Adj', x: W / 2, y: H / 2 } }]);
    const base = await frame();
    const problems: string[] = [];
    for (const [type, params] of Object.entries(EFFECTS)) {
      const p: Record<string, unknown> = { ...params };
      if (LAYER_PARAM[type]) p[LAYER_PARAM[type]] = named('Star');
      const host = named(ON_LAYER.has(type) ? 'Box' : 'Adj');
      const r = await runToolTurn(`AI: ${type}`, [{ name: 'add_effect', args: { nodeId: host, type, id: 'fx', params: p } }]);
      if (!r.results[0]!.ok) problems.push(`${type}: ${r.results[0]!.content}`);
      const f = await frame();
      await engineIdle();
      const errs = documentMirror().layerErrors(activeCompRootId() as string).filter((e) => e.stage !== 'font');
      if (errs.length) problems.push(`${type}: ${errs.map((e) => `${e.stage} ${e.message}`).join('; ')}`);
      if (meanDiff(base, f) < 0.05) problems.push(`${type}: no visible change`);
      await runToolTurn('AI: remove', [{ name: 'update_effect', args: { nodeId: host, effectId: 'fx', remove: true } }]);
    }
    expect(problems).toEqual([]);
  }, 600_000);

  it('Brightness & Contrast brightens; Long Shadow casts down-right; Blend takes the other layer', async () => {
    await clear();
    await runToolTurn('AI: scene', scene);
    const base = await frame();
    const box = (): string => documentMirror().layerIds().find((id) => documentMirror().layer(id)?.name === 'Box')!;
    const bg = (): string => documentMirror().layerIds().find((id) => documentMirror().layer(id)?.name === 'BG')!;

    await runToolTurn('AI: bc', [{ name: 'add_effect', args: { nodeId: bg(), type: 'brightness-contrast', id: 'bc', params: { brightness: 80 } } }]);
    const bright = await frame();
    expect(px(bright, 300, 160)[0]).toBeGreaterThan(px(base, 300, 160)[0] + 20);
    await runToolTurn('AI: rm', [{ name: 'update_effect', args: { nodeId: bg(), effectId: 'bc', remove: true } }]);

    // The box spans x 40..140, y 65..135; its long shadow lands below-right of it.
    await runToolTurn('AI: ls', [{ name: 'add_effect', args: { nodeId: box(), type: 'long-shadow', id: 'ls', params: { length: 60, shadowOpacity: 100, fade: 0 } } }]);
    const shadow = await frame();
    expect(px(shadow, 160, 150)[2]).toBeLessThan(px(base, 160, 150)[2] - 60);
    expect(px(shadow, 20, 40)).toEqual(px(base, 20, 40));
    await runToolTurn('AI: rm', [{ name: 'update_effect', args: { nodeId: box(), effectId: 'ls', remove: true } }]);

    // Crossfaded fully to the star: where the star is not, the box is gone and the background shows.
    await runToolTurn('AI: blend', [{ name: 'add_effect', args: { nodeId: box(), type: 'blend', id: 'bl', params: { blendLayer: named('Star') } } }]);
    const blended = await frame();
    const [r, g, b] = px(blended, 90, 100);
    const [r0, g0, b0] = px(base, 300, 160);
    expect(Math.abs(r - r0) + Math.abs(g - g0) + Math.abs(b - b0)).toBeLessThan(12);
  }, 120_000);

  it('a clock-driven effect moves on its own; with Animate With Time off it holds', async () => {
    await clear();
    await runToolTurn('AI: scene', scene);
    const box = documentMirror().layerIds().find((id) => documentMirror().layer(id)?.name === 'Box')!;
    await runToolTurn('AI: shake', [{ name: 'add_effect', args: { nodeId: box, type: 'camera-shake', id: 'sh', params: { amount: 25, motionBlur: 0, edges: 0 } } }]);
    const a = await frame(0.4);
    const b = await frame(1.3);
    expect(meanDiff(a, b)).toBeGreaterThan(0.2);
    await runToolTurn('AI: hold', [{ name: 'update_effect_param', args: { nodeId: box, effectId: 'sh', key: 'followCompTime', value: false } }]);
    const c = await frame(0.4);
    const d = await frame(1.3);
    expect(meanDiff(c, d)).toBe(0);
  }, 120_000);
});
