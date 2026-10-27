/**
 * The 3D switch and the anchor convention (found building the Carousel plugin,
 * 2026-10-27):
 *
 *   1. `setLayerSwitches {threeD: true}` on a sized solid keeps its size,
 *      position and anchor — it used to reseed the solid to the comp size, the
 *      comp centre and an anchor of (w/2, h/2).
 *   2. `getLayerBounds` agrees with the renderer about the anchor. Layer space
 *      is centre-origin (ENGINE_API.md §3): the content sits at
 *      position − anchor, on 2D and 3D layers alike. The bounds used to ignore
 *      the anchor. The GPU half checks the drawn pixels say the same.
 */

import { PNG } from 'pngjs';
import type { Command } from '@motion/engine-api';
import { sec, settleEdits, setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';

jest.setTimeout(60_000);

type Val = { kind: string; value: unknown };
type Box = { x: number; y: number; width: number; height: number };

async function solid(h: Harness, w: number, ht: number): Promise<string> {
  return (await h.run({
    type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'Card',
    init: [{ path: 'layer/width', value: { kind: 'scalar', value: w } }, { path: 'layer/height', value: { kind: 'scalar', value: ht } }],
  } as Command as never) as unknown as { layer: string }).layer;
}

async function values(h: Harness, layer: string, paths: string[]): Promise<Val[]> {
  const r = (await h.query({ type: 'getPropertyValues', props: paths.map((path) => ({ layer, path })), time: 0, evaluated: false } as never)) as unknown as { values: Array<{ value: Val }> };
  return r.values.map((v) => v.value);
}

async function bounds(h: Harness, layer: string): Promise<Box> {
  const b = (await h.query({ type: 'getLayerBounds', layers: [layer], time: 0, space: 'comp', includeEffects: false } as never)) as unknown as { bounds: Array<{ bounds: Box }> };
  return b.bounds[0]!.bounds;
}

const near = (b: Box, want: Box): void => {
  expect(b.x).toBeCloseTo(want.x, 3);
  expect(b.y).toBeCloseTo(want.y, 3);
  expect(b.width).toBeCloseTo(want.width, 3);
  expect(b.height).toBeCloseTo(want.height, 3);
};

describe('3D switch and anchor (document)', () => {
  let h: Harness;
  beforeEach(async () => { h = await setupAppEngine(); });
  afterEach(async () => { await h.dispose(); });

  it('turning a sized solid 3D keeps its size, position and anchor', async () => {
    const id = await solid(h, 360, 480);
    await h.run({ type: 'setProperty', prop: { layer: id, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 500, y: 300 } } } as never);
    await h.run({ type: 'setProperty', prop: { layer: id, path: 'transform/anchorPoint' }, value: { kind: 'vec2', value: { x: 20, y: -10 } } } as never);
    const before = await bounds(h, id);
    await h.run({ type: 'setLayerSwitches', layers: [id], patch: { threeD: true } } as never);
    const [w, ht, pos, anchor] = await values(h, id, ['layer/width', 'layer/height', 'transform/position', 'transform/anchorPoint']);
    expect(w!.value).toBe(360);
    expect(ht!.value).toBe(480);
    expect(pos!.value).toEqual({ x: 500, y: 300, z: 0 });
    expect(anchor!.value).toEqual({ x: 20, y: -10, z: 0 });
    // The same box on screen (default camera, z = 0).
    near(await bounds(h, id), before);
  });

  it('an unsized solid that turns 3D still fills the comp', async () => {
    const id = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'BG', init: [] } as never) as unknown as { layer: string }).layer;
    const before = await bounds(h, id);
    await h.run({ type: 'setLayerSwitches', layers: [id], patch: { threeD: true } } as never);
    near(await bounds(h, id), before);
    near(before, { x: 0, y: 0, width: 1920, height: 1080 });
  });

  it.each([false, true])('bounds put the content at position − anchor (3D %s)', async (threeD) => {
    const id = await solid(h, 200, 200);
    if (threeD) await h.run({ type: 'setLayerSwitches', layers: [id], patch: { threeD: true } } as never);
    await h.run({ type: 'setProperty', prop: { layer: id, path: 'transform/position' }, value: threeD ? { kind: 'vec3', value: { x: 1100, y: 540, z: 0 } } : { kind: 'vec2', value: { x: 1100, y: 540 } } } as never);
    await h.run({ type: 'setProperty', prop: { layer: id, path: 'transform/anchorPoint' }, value: threeD ? { kind: 'vec3', value: { x: 100, y: 100, z: 0 } } : { kind: 'vec2', value: { x: 100, y: 100 } } } as never);
    // Centre-origin anchor (100, 100) = the box's bottom-right corner: it sits on the position.
    near(await bounds(h, id), { x: 900, y: 340, width: 200, height: 200 });
  });
});

const gpuSuite = process.env.PREMATION_GPU_TESTS === '1' ? describe : describe.skip;

gpuSuite('3D switch and anchor (pixels)', () => {
  const W = 960;
  let h: Harness;
  beforeAll(async () => {
    h = await setupAppEngine({ gpu: true });
    await h.run({ type: 'setCompositionSettings', comp: 'comp_root', patch: { width: 1920, height: 1080, duration: sec(2), background: { r: 0, g: 0, b: 0, a: 1 } } } as never);
  });
  afterAll(async () => { await h.dispose(); });

  async function frame(): Promise<PNG> {
    await settleEdits();
    const th = (await h.query({ type: 'getThumbnail', item: 'comp_root', time: 0, maxSize: W } as never)) as unknown as { data: Uint8Array };
    return PNG.sync.read(Buffer.from(th.data));
  }
  /** Whether comp pixel (x, y) is lit (the solid is white on black). */
  const lit = (p: PNG, x: number, y: number): boolean => {
    const i = (Math.round((y * p.height) / 1080) * p.width + Math.round((x * p.width) / 1920)) * 4;
    return p.data[i]! > 128;
  };

  it.each([false, true])('the drawn solid sits where the bounds say (3D %s)', async (threeD) => {
    const id = await solid(h, 200, 200);
    await h.run({ type: 'setProperty', prop: { layer: id, path: 'layer/fill' }, value: { kind: 'color', value: { r: 1, g: 1, b: 1, a: 1 } } } as never);
    if (threeD) await h.run({ type: 'setLayerSwitches', layers: [id], patch: { threeD: true } } as never);
    await h.run({ type: 'setProperty', prop: { layer: id, path: 'transform/position' }, value: threeD ? { kind: 'vec3', value: { x: 1100, y: 540, z: 0 } } : { kind: 'vec2', value: { x: 1100, y: 540 } } } as never);
    await h.run({ type: 'setProperty', prop: { layer: id, path: 'transform/anchorPoint' }, value: threeD ? { kind: 'vec3', value: { x: 100, y: 100, z: 0 } } : { kind: 'vec2', value: { x: 100, y: 100 } } } as never);
    const b = await bounds(h, id);
    const p = await frame();
    expect(lit(p, b.x + b.width / 2, b.y + b.height / 2)).toBe(true);
    expect(lit(p, b.x + 20, b.y + 20)).toBe(true);
    expect(lit(p, b.x + b.width - 20, b.y + b.height - 20)).toBe(true);
    expect(lit(p, b.x + b.width + 20, b.y + b.height + 20)).toBe(false);
    await h.run({ type: 'deleteLayers', layers: [id] } as never);
  });
});
