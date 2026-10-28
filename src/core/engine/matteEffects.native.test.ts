/**
 * Program X batch 8 (docs/PROGRAM_DEEP_EFFECTS.md #57–58): the effects that
 * work on a matte — Matte Stroke (an outline from the matte's distance field)
 * and Selective Color (AI) (a correction confined to a matte, or to everything
 * outside it). Rendered on the app's engine with the full renderer: each must
 * reach the GPU chain (no effect error on the layer) and do what it says.
 *
 * Needs a GPU adapter (PREMATION_GPU_TESTS=1).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
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

suite('matte effects on the full renderer', () => {
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
  async function frame(t = 0): Promise<PNG> {
    await settleEdits();
    const th = (await h.query({ type: 'getThumbnail', item: activeCompRootId() as string, time: sec(t), maxSize: W } as never)) as { data: Uint8Array };
    return PNG.sync.read(Buffer.from(th.data));
  }
  const px = (p: PNG, x: number, y: number): [number, number, number] => {
    const i = (Math.round(y * p.height / H) * p.width + Math.round(x * p.width / W)) * 4;
    return [p.data[i]!, p.data[i + 1]!, p.data[i + 2]!];
  };
  const lum = (c: [number, number, number]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const chroma = (c: [number, number, number]): number => Math.max(...c) - Math.min(...c);
  const meanDiff = (a: PNG, b: PNG): number => {
    let s = 0;
    for (let i = 0; i < a.data.length; i += 4) s += Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!);
    return s / (a.data.length / 4) / 3;
  };
  const named = (name: string): string => {
    const m = documentMirror();
    return m.layerIds().find((id) => m.layer(id)?.name === name && m.layer(id)?.comp === activeCompRootId())!;
  };
  /** PREMATION_DUMP_DIR: every checked frame is written there as <name>.png. */
  const dump = (name: string, p: PNG): void => {
    const dir = process.env.PREMATION_DUMP_DIR;
    if (dir) fs.writeFileSync(path.join(dir, `${name}.png`), PNG.sync.write(p));
  };
  async function errors(): Promise<string[]> {
    await engineIdle();
    return documentMirror().layerErrors(activeCompRootId() as string).filter((e) => e.stage !== 'font').map((e) => `${e.stage} ${e.message}`);
  }
  async function withEffect(host: string, type: string, params: Record<string, unknown>, name = type): Promise<PNG> {
    const r = await runToolTurn(`AI: ${type}`, [{ name: 'add_effect', args: { nodeId: named(host), type, id: 'fx', params } }]);
    expect(r.results[0]!.ok).toBe(true);
    const f = await frame();
    dump(name, f);
    expect(await errors()).toEqual([]);
    await runToolTurn('AI: remove', [{ name: 'update_effect', args: { nodeId: named(host), effectId: 'fx', remove: true } }]);
    return f;
  }

  // The box spans x 40..140, y 65..135 (white on navy); the star sits at (240, 70).
  const scene = [
    { name: 'create_layer', args: { id: 'bg', kind: 'solid', name: 'BG', x: W / 2, y: H / 2, width: W, height: H, fill: '#20243a' } },
    { name: 'create_layer', args: { id: 'star', kind: 'shape', shape: 'star', name: 'Star', x: 240, y: 70, width: 90, height: 90, points: 5, fill: '#ffe680' } },
    { name: 'create_layer', args: { id: 'box', kind: 'shape', shape: 'rect', name: 'Box', x: 90, y: 100, width: 100, height: 70, fill: '#f4f4f4' } },
  ];

  it('Matte Stroke outlines the layer\'s alpha outside, center or inside, with glow and on transparent', async () => {
    await clear();
    await runToolTurn('AI: scene', scene);
    const base = await frame();
    dump('mstroke-base', base);
    const red = '#ff2020';
    // Outside, 8 px: 4 px left of the box's left edge (x 40) is red, its inside stays white.
    const out = await withEffect('Box', 'matte-stroke', { width: 8, color: red }, 'mstroke-outside');
    expect(px(out, 36, 100)[0]).toBeGreaterThan(200);
    expect(px(out, 36, 100)[1]).toBeLessThan(90);
    expect(lum(px(out, 48, 100))).toBeGreaterThan(220);
    // Far from the box the ground is untouched.
    expect(Math.abs(lum(px(out, 10, 20)) - lum(px(base, 10, 20)))).toBeLessThan(3);
    // Inside, 8 px: 4 px inside the edge is red, 4 px outside is the ground.
    const ins = await withEffect('Box', 'matte-stroke', { width: 8, color: red, position: 2 }, 'mstroke-inside');
    expect(px(ins, 44, 100)[0]).toBeGreaterThan(200);
    expect(px(ins, 44, 100)[1]).toBeLessThan(90);
    expect(Math.abs(lum(px(ins, 36, 100)) - lum(px(base, 36, 100)))).toBeLessThan(6);
    // Center, 8 px: both sides of the edge.
    const mid = await withEffect('Box', 'matte-stroke', { width: 8, color: red, position: 1 }, 'mstroke-center');
    expect(px(mid, 38, 100)[1]).toBeLessThan(90);
    expect(px(mid, 42, 100)[1]).toBeLessThan(90);
    expect(lum(px(mid, 50, 100))).toBeGreaterThan(220);
    // A glow lights the ground well past the stroke.
    const glow = await withEffect('Box', 'matte-stroke', { width: 4, color: red, glowAmount: 300, glowRadius: 24 }, 'mstroke-glow');
    expect(px(glow, 25, 100)[0]).toBeGreaterThan(px(base, 25, 100)[0] + 15);
    // On Transparent: the stroke alone, the box's own pixels gone.
    const alone = await withEffect('Box', 'matte-stroke', { width: 8, color: red, composite: 1 }, 'mstroke-alone');
    expect(px(alone, 36, 100)[0]).toBeGreaterThan(200);
    expect(Math.abs(lum(px(alone, 90, 100)) - lum(px(base, 10, 20)))).toBeLessThan(6);
  }, 300_000);

  it('Matte Stroke dashes along the contour, and the offset marches them', async () => {
    await clear();
    await runToolTurn('AI: scene', scene);
    // The box's top edge (y 65): sample 4 px above it along x 50..130.
    const along = (p: PNG): number[] => Array.from({ length: 41 }, (_, i) => px(p, 50 + i * 2, 61)[0]);
    const solid = await withEffect('Box', 'matte-stroke', { width: 8, color: '#ff2020' }, 'mstroke-solid');
    expect(Math.min(...along(solid))).toBeGreaterThan(200);
    const dashed = await withEffect('Box', 'matte-stroke', { width: 8, color: '#ff2020', dashed: true, dashLength: 10, gapLength: 10 }, 'mstroke-dashed');
    const d = along(dashed);
    // Dashes and gaps both: some samples are stroke red, some the navy ground.
    expect(d.filter((r) => r > 200).length).toBeGreaterThan(6);
    expect(d.filter((r) => r < 80).length).toBeGreaterThan(6);
    const marched = await withEffect('Box', 'matte-stroke', { width: 8, color: '#ff2020', dashed: true, dashLength: 10, gapLength: 10, dashOffset: 10 }, 'mstroke-marched');
    // Half a period on: where there was a dash there is a gap, mostly.
    const m = along(marched);
    let flipped = 0;
    for (let i = 0; i < d.length; i++) if ((d[i]! > 200 && m[i]! < 80) || (d[i]! < 80 && m[i]! > 200)) flipped++;
    expect(flipped).toBeGreaterThan(8);
  }, 300_000);

  it('Matte Stroke outlines another layer\'s matte (Matte Layer)', async () => {
    await clear();
    await runToolTurn('AI: scene', [...scene, { name: 'create_layer', args: { id: 'adj', kind: 'adjustment', name: 'Adj', x: W / 2, y: H / 2 } }]);
    const base = await frame();
    const f = await withEffect('Adj', 'matte-stroke', { width: 6, color: '#20ff40', matteLayerId: named('Star') }, 'mstroke-layer');
    expect(meanDiff(base, f)).toBeGreaterThan(0.2);
    // Around the star, not around the box: the box's edge is untouched.
    expect(Math.abs(lum(px(f, 37, 100)) - lum(px(base, 37, 100)))).toBeLessThan(6);
    // Just above the star's top tip (240, 25) the ground turns green.
    const tip = [0, 1, 2, 3, 4].map((k) => px(f, 240, 22 - k)).find((c) => c[1] > 150 && c[0] < 120);
    expect(tip).toBeDefined();
  }, 300_000);

  /** A red-orange full-frame solid over a hidden-under ellipse (the matte layer). */
  async function colourScene(): Promise<void> {
    await clear();
    await runToolTurn('AI: scene', [
      { name: 'create_layer', args: { id: 'spot', kind: 'shape', shape: 'ellipse', name: 'Spot', x: 100, y: 90, width: 100, height: 100, fill: '#ffffff' } },
      { name: 'create_layer', args: { id: 'red', kind: 'solid', name: 'Red', x: W / 2, y: H / 2, width: W, height: H, fill: '#d0502a' } },
    ]);
  }

  it('Selective Color (AI) through a Matte Layer: desaturate everything but the subject, or colour the subject', async () => {
    await colourScene();
    const base = await frame();
    dump('selcol-base', base);
    expect(chroma(px(base, 100, 90))).toBeGreaterThan(100);
    const outside = await withEffect('Red', 'selective-color-ai', { matteLayerId: named('Spot'), applyTo: 1, saturation: -100 }, 'selcol-outside');
    // Inside the spot the red stays; outside it is grey.
    expect(chroma(px(outside, 100, 90))).toBeGreaterThan(100);
    expect(chroma(px(outside, 260, 90))).toBeLessThan(8);
    const inside = await withEffect('Red', 'selective-color-ai', { matteLayerId: named('Spot'), colorize: true, colorizeColor: '#2060ff', colorizeAmount: 100 }, 'selcol-inside');
    const c = px(inside, 100, 90);
    expect(c[2]).toBeGreaterThan(c[0] + 40);
    // Outside the spot: the base red.
    expect(Math.abs(px(inside, 260, 90)[0] - px(base, 260, 90)[0])).toBeLessThan(4);
    // Hue shift 180 inside: red turns toward cyan; feathered and choked edges still render.
    const hue = await withEffect('Red', 'selective-color-ai', { matteLayerId: named('Spot'), hue: 180, matteFeather: 8, matteChoke: 6 }, 'selcol-hue');
    const hc = px(hue, 100, 90);
    expect(hc[2]).toBeGreaterThan(hc[0]);
  }, 300_000);

  it('Selective Color (AI) reads the layer\'s own Object Matte without cutting it out', async () => {
    await colourScene();
    // The layer's per-frame cut-out: the left half opaque, the right half clear.
    const png = new PNG({ width: W, height: H });
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        png.data[i] = 208; png.data[i + 1] = 80; png.data[i + 2] = 42;
        png.data[i + 3] = x < W / 2 ? 255 : 0;
      }
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'premation-matte-'));
    const file = path.join(dir, 'matte_000000.png');
    fs.writeFileSync(file, PNG.sync.write(png));
    await h.run({ type: 'setLayerMatte', layer: named('Red'), frames: [{ time: sec(0), src: file }] } as Command);
    await settleEdits();
    const f = await withEffect('Red', 'selective-color-ai', { applyTo: 0, saturation: -100 }, 'selcol-objectmatte');
    // Left (the matte): grey. Right (outside it): the red, still there — not cut out.
    expect(chroma(px(f, 60, 40))).toBeLessThan(8);
    expect(chroma(px(f, 260, 40))).toBeGreaterThan(100);
    expect(px(f, 260, 40)[0]).toBeGreaterThan(150);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 300_000);
});
