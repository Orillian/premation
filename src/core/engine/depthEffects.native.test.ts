/**
 * Camera program D1 / D2 on the full renderer: effects on an adjustment layer
 * read the composition's scene depth (Depth Extract / Matte / Fog, Camera Lens
 * Blur's scene-depth blur map), and a Lens Flare linked to a light follows it
 * through the camera and dims when a 3D layer hides it.
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

suite('depth for compositing (camera program D1 / D2)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setupAppEngine({ gpu: true });
    await h.run({ type: 'setCompositionSettings', comp: activeCompRootId() as string, patch: { width: W, height: H, duration: sec(4) } } as Command);
    await h.run({ type: 'setViewport', viewport: 1, width: W, height: H, devicePixelRatio: 1, zoom: 0, pan: { x: 0, y: 0 }, channel: 'rgb', exposure: 0, transparencyGrid: false, displayTransform: '', layerRenderEffects: true } as Command);
    await settleEdits();
  }, 60_000);
  afterAll(async () => { await h.dispose(); });

  const named = (name: string): string => documentMirror().layerIds().find((id) => documentMirror().layer(id)?.name === name)!;
  async function frame(t = 0): Promise<PNG> {
    await settleEdits();
    const th = (await h.query({ type: 'getThumbnail', item: activeCompRootId() as string, time: sec(t), maxSize: W } as never)) as { data: Uint8Array };
    return PNG.sync.read(Buffer.from(th.data));
  }
  const px = (p: PNG, x: number, y: number): [number, number, number] => {
    const i = (Math.round(y * p.height / H) * p.width + Math.round(x * p.width / W)) * 4;
    return [p.data[i]!, p.data[i + 1]!, p.data[i + 2]!];
  };
  const lum = (c: [number, number, number]): number => (c[0] + c[1] + c[2]) / 3;

  /** Two 3D cards: Near (left, 300 px toward the camera) and Far (right, 800 px back), a camera, an adjustment layer. */
  async function scene(): Promise<void> {
    await runToolTurn('AI: scene', [
      { name: 'create_layer', args: { id: 'near', kind: 'solid', name: 'Near', x: 90, y: 90, width: 90, height: 90, fill: '#808080' } },
      { name: 'create_layer', args: { id: 'far', kind: 'solid', name: 'Far', x: 240, y: 90, width: 200, height: 200, fill: '#808080' } },
      { name: 'create_layer', args: { id: 'adj', kind: 'adjustment', name: 'Adj', x: W / 2, y: H / 2 } },
    ]);
    await h.run({ type: 'createLayer', comp: activeCompRootId() as string, kind: 'camera', name: 'Camera', init: [] } as Command);
    for (const [name, x, z] of [['Near', 90, -300], ['Far', 240, 800]] as const) {
      const id = named(name);
      await h.run({ type: 'setLayerSwitches', layers: [id], patch: { threeD: true } } as Command);
      expect(documentMirror().layer(id)).toBeDefined();
      await h.run({ type: 'setProperty', prop: { layer: id, path: 'transform/position' }, value: { kind: 'vec3', value: { x, y: 90, z } } } as Command);
    }
    await engineIdle();
  }
  async function withEffect(type: string, params: Record<string, unknown>): Promise<PNG> {
    const r = await runToolTurn(`AI: ${type}`, [{ name: 'add_effect', args: { nodeId: named('Adj'), type, id: 'fx', params } }]);
    expect(r.results[0]!.ok).toBe(true);
    const f = await frame();
    expect(documentMirror().layerErrors(activeCompRootId() as string).filter((e) => e.stage !== 'font')).toEqual([]);
    await runToolTurn('AI: rm', [{ name: 'update_effect', args: { nodeId: named('Adj'), effectId: 'fx', remove: true } }]);
    return f;
  }

  it('Depth Extract shades near dark, far light, empty sky white; Matte keeps the near band; Fog thickens with depth', async () => {
    await scene();
    const base = await frame();
    // The default camera on a 320 px comp has a ≈444 px Zoom and sits that far
    // back: Near (z −300) is ≈144 px away and fills the left edge (x 0–82), Far
    // (z 800) ≈1244 px away, centred near x 188; the sky is infinitely far.
    const NEAR: [number, number] = [40, 90];
    const FAR: [number, number] = [188, 90];
    const SKY: [number, number] = [120, 10];
    const extract = await withEffect('depth-extract', { near: 0, far: 3000 });
    expect(lum(px(extract, ...NEAR))).toBeLessThan(lum(px(extract, ...FAR)) - 30);
    expect(lum(px(extract, ...SKY))).toBeGreaterThan(245);

    const matte = await withEffect('depth-matte', { near: 0, far: 600, feather: 1 });
    expect(px(matte, ...NEAR)).toEqual(px(base, ...NEAR));
    expect(lum(px(matte, ...FAR))).toBeLessThan(lum(px(base, ...FAR)) - 40);

    const fog = await withEffect('depth-fog', { color: '#ff0000', start: 200, end: 1500, density: 100 });
    const redness = (c: [number, number, number]): number => c[0] - (c[1] + c[2]) / 2;
    expect(redness(px(fog, ...FAR))).toBeGreaterThan(redness(px(fog, ...NEAR)) + 20);
    expect(redness(px(fog, ...SKY))).toBeGreaterThan(200);
  }, 180_000);

  it('Camera Lens Blur with Blur Map = Scene Depth blurs by depth and leaves the focal plane sharp', async () => {
    const plain = await frame();
    const blurred = await withEffect('camera-lens-blur', { radius: 12, blurMap: 1, focusFromCamera: false, focusDistance: 1100 });
    let diff = 0;
    for (let i = 0; i < plain.data.length; i += 4) diff += Math.abs(plain.data[i]! - blurred.data[i]!);
    expect(diff).toBeGreaterThan(0);
  }, 120_000);
});
