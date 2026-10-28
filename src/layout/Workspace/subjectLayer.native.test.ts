/**
 * A cut-out handles as what it shows (layer_geometry.cpp visible_geometry_at):
 * the engine's layer box and click selection follow the masks, Centre Anchor
 * centres on the visible part, New Layer from Subject lifts the subject alone,
 * and a mask's own settings (lock, colour, Feather Falloff, Motion Blur) are
 * static properties held across its shape keys.
 */

import { engine, engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels, settleEdits, sec, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import { documentMirror } from '@stores/documentMirror';
import { mirrorMasksAt } from '@core/mirror/masks';
import { mirrorEffectHeaders, mirrorMaskHeaders } from '@core/mirror/effects';
import { centreAnchorEdit, centredAnchor } from '@layout/Menu/appEdits';
import { newLayerFromSubjectEdit, subjectPartsOf } from './newLayerFromSubject';

let h: Harness;
let s: Scene;

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  await settleEdits();
  await documentMirror().loadTrees(documentMirror().layerIds());
});
afterEach(async () => { await h.dispose(); });

const square = (x0: number, y0: number, size: number) => ({
  vertices: [x0, y0, x0 + size, y0, x0 + size, y0 + size, x0, y0 + size],
  inTangents: [], outTangents: [], closed: true, featherPoints: [], vertexStates: [],
});

async function layerBox(layer: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const res = await engine().query({ type: 'getLayerBounds', layers: [layer], time: 0, space: 'layer', includeEffects: false });
  if (!res.ok) throw new Error(res.error.message);
  return res.value.bounds[0]!.bounds;
}

describe('visible bounds', () => {
  it('a mask that cuts shrinks the box to the mask; Subtract and None leave it whole', async () => {
    // Solid A carries the scene's 100 × 100 Add mask at (0, 0).
    expect(await layerBox(s.A)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    await h.run({ type: 'setProperty', prop: { layer: s.A, path: `masks/${s.mask}/mode` }, value: { kind: 'choice', value: 'subtract' } });
    const whole = await layerBox(s.A);
    expect(whole.width).toBeGreaterThan(100);
    await h.run({ type: 'setProperty', prop: { layer: s.A, path: `masks/${s.mask}/mode` }, value: { kind: 'choice', value: 'none' } });
    expect(await layerBox(s.A)).toEqual(whole);
  });

  it('Add masks unite, an Intersect narrows, Inverted Add shows everything', async () => {
    await h.run({ type: 'addMask', layer: s.A, mode: 'add', inverted: false, path: square(200, 200, 50) });
    expect(await layerBox(s.A)).toEqual({ x: 0, y: 0, width: 250, height: 250 });
    const { groups: [cut] } = await h.run({ type: 'addMask', layer: s.A, mode: 'intersect', inverted: false, path: square(-20, -20, 70) });
    expect(await layerBox(s.A)).toEqual({ x: 0, y: 0, width: 50, height: 50 });
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: s.A, path: cut! }] });
    await h.run({ type: 'setProperty', prop: { layer: s.A, path: `masks/${s.mask}/inverted` }, value: { kind: 'bool', value: true } });
    expect((await layerBox(s.A)).width).toBeGreaterThan(250);
  });

  it('Feather and Expansion widen the box by what the soft edge reaches', async () => {
    await h.run({ type: 'setProperty', prop: { layer: s.A, path: `masks/${s.mask}/feather` }, value: { kind: 'scalar', value: 20 } });
    await h.run({ type: 'setProperty', prop: { layer: s.A, path: `masks/${s.mask}/expansion` }, value: { kind: 'scalar', value: 5 } });
    // 5 px expansion + half of the 20 px feather on every side.
    expect(await layerBox(s.A)).toEqual({ x: -15, y: -15, width: 130, height: 130 });
  });

  it('a mask outside the layer keeps the whole box, so the layer stays reachable', async () => {
    await h.run({ type: 'setProperty', prop: { layer: s.A, path: `masks/${s.mask}/path` }, value: { kind: 'path', value: square(50_000, 50_000, 10) } });
    expect((await layerBox(s.A)).width).toBeGreaterThan(100);
  });
});

describe('Centre Anchor Point in Layer Content', () => {
  it('moves the anchor to the visible centre without moving the picture', async () => {
    const before = await engine().query({ type: 'getLayerBounds', layers: [s.A], time: 0, space: 'comp', includeEffects: false });
    await centreAnchorEdit([s.A], 0);
    await settleEdits();
    expect((await historyLabels()).at(-1)).toBe('Centre Anchor Point');
    const after = await engine().query({ type: 'getLayerBounds', layers: [s.A], time: 0, space: 'comp', includeEffects: false });
    expect(after.ok && before.ok).toBe(true);
    if (after.ok && before.ok) {
      const a = after.value.bounds[0]!.bounds;
      const b = before.value.bounds[0]!.bounds;
      expect(a.x).toBeCloseTo(b.x, 3);
      expect(a.y).toBeCloseTo(b.y, 3);
    }
    const anchor = await h.query({ type: 'getPropertyValues', props: [{ layer: s.A, path: 'transform/anchorPoint' }], time: 0, evaluated: true });
    expect(anchor.values[0]!.value).toMatchObject({ value: { x: 50, y: 50 } });
  });

  it('compensates Position through scale and rotation', () => {
    const r = centredAnchor({ x: 10, y: 0 }, { anchorX: 0, anchorY: 0, x: 100, y: 100, scaleX: 2, scaleY: 2, rotation: 90 });
    expect(r!.anchorX).toBe(10);
    expect(r!.x).toBeCloseTo(100, 6);
    expect(r!.y).toBeCloseTo(120, 6);
    expect(centredAnchor({ x: 0, y: 0 }, { anchorX: 0, anchorY: 0, x: 1, y: 2, scaleX: 1, scaleY: 1, rotation: 0 })).toBeNull();
  });
});

describe('New Layer from Subject', () => {
  it('copies the subject alone above the original, in one entry, leaving the original untouched', async () => {
    // A: the scene's Glow + a 100 × 100 Add mask; add a None mask (path-effect geometry).
    await h.run({ type: 'addMask', layer: s.A, mode: 'none', inverted: false, path: square(300, 300, 20) });
    await engineIdle();
    await documentMirror().loadTrees([s.A]);
    const beforeTree = documentMirror().tree(s.A);
    const entries = (await historyLabels()).length;
    const res = await newLayerFromSubjectEdit(s.A, 0);
    await settleEdits();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((await historyLabels()).length).toBe(entries + 1);
    expect((await historyLabels()).at(-1)).toBe('New Layer from Subject');
    await documentMirror().loadTrees([res.layer, s.A]);
    const copy = documentMirror().tree(res.layer);
    expect(mirrorEffectHeaders(copy)).toEqual([]);
    expect(mirrorMaskHeaders(copy)).toHaveLength(1);
    expect(documentMirror().layer(res.layer)?.name).toBe('A (subject)');
    // The original keeps its effect and both masks.
    expect(mirrorEffectHeaders(documentMirror().tree(s.A))).toHaveLength(mirrorEffectHeaders(beforeTree).length);
    expect(mirrorMaskHeaders(documentMirror().tree(s.A))).toHaveLength(2);
    // The copy's anchor sits on the subject, and it draws where the original's subject is.
    const box = await engine().query({ type: 'getLayerBounds', layers: [s.A, res.layer], time: 0, space: 'comp', includeEffects: false });
    expect(box.ok).toBe(true);
    if (box.ok) {
      const [orig, cut] = box.value.bounds;
      expect(cut!.bounds.x).toBeCloseTo(orig!.bounds.x, 3);
      expect(cut!.bounds.width).toBeCloseTo(orig!.bounds.width, 3);
    }
    await h.run({ type: 'undo' });
    await settleEdits();
    expect(documentMirror().layer(res.layer)).toBeUndefined();
  });

  it('refuses a layer with no subject, changing nothing', async () => {
    const entries = (await historyLabels()).length;
    const res = await newLayerFromSubjectEdit(s.B, 0);
    expect(res).toMatchObject({ ok: false, reason: 'noSubject' });
    expect((await historyLabels()).length).toBe(entries);
  });

  it('keeps Roto Brush / Object Matte outlines and turns a shown Roto selection into a cut', () => {
    const tree = {
      nodes: new Map<string, { name: string; children?: string[]; value?: unknown; matchName?: string; enabled?: boolean }>([
        ['masks', { name: 'Masks', children: ['masks/r', 'masks/g'] }],
        ['masks/r', { name: 'Roto Brush' }],
        ['masks/r/mode', { name: 'Mode', value: { kind: 'choice', value: 'none' } }],
        ['masks/g', { name: 'Mask 2' }],
        ['masks/g/mode', { name: 'Mode', value: { kind: 'choice', value: 'none' } }],
        ['styles', { name: 'Layer Styles', children: ['styles/dropShadow'] }],
        ['styles/dropShadow', { name: 'Drop Shadow' }],
        ['effects', { name: 'Effects', children: ['effects/grade', 'effects/blur'] }],
        ['effects/grade', { name: 'Lumetri Color', matchName: 'lumetri' }],
        ['effects/blur', { name: 'Gaussian Blur', matchName: 'gaussian-blur' }],
      ]),
    } as unknown as Parameters<typeof subjectPartsOf>[0];
    const parts = subjectPartsOf(tree);
    expect(parts.keepMasks).toEqual(['r']);
    expect(parts.keepEffects).toEqual(['grade']);
    expect(parts.dropEffects).toEqual(['blur']);
    expect(parts.rotoToCut).toEqual(['r']);
    expect(parts.dropMasks).toEqual(['g']);
    expect(parts.dropStyles).toEqual(['dropShadow']);
  });
});

describe('mask settings', () => {
  it('lock, colour, Feather Falloff and Motion Blur: static, defaulted, one entry each, held in every shape key', async () => {
    const at = () => mirrorMasksAt(documentMirror(), s.A, 0)[0]!;
    await documentMirror().loadTrees([s.A]);
    expect(at()).toMatchObject({ locked: false, featherFalloff: 'smooth', motionBlur: 'sameAsLayer' });
    expect(at().color).toMatch(/^#[0-9a-f]{6}$/);
    // Key the shape at two times, then set each: every key carries the setting.
    await h.run({
      type: 'addKeyframes',
      keys: [
        { prop: { layer: s.A, path: `masks/${s.mask}/path` }, time: 0, value: { kind: 'path', value: square(0, 0, 100) }, spatialIn: [], spatialOut: [] },
        { prop: { layer: s.A, path: `masks/${s.mask}/path` }, time: sec(1), value: { kind: 'path', value: square(40, 0, 100) }, spatialIn: [], spatialOut: [] },
      ],
    });
    await h.run({ type: 'setProperty', prop: { layer: s.A, path: `masks/${s.mask}/locked` }, value: { kind: 'bool', value: true } });
    await h.run({ type: 'setProperty', prop: { layer: s.A, path: `masks/${s.mask}/color` }, value: { kind: 'color', value: { r: 1, g: 0, b: 0, a: 1 } } });
    await h.run({ type: 'setProperty', prop: { layer: s.A, path: `masks/${s.mask}/featherFalloff` }, value: { kind: 'choice', value: 'linear' } });
    await h.run({ type: 'setProperty', prop: { layer: s.A, path: `masks/${s.mask}/motionBlur` }, value: { kind: 'choice', value: 'on' } });
    await engineIdle();
    for (const t of [0, sec(0.5), sec(1)]) {
      expect(mirrorMasksAt(documentMirror(), s.A, t)[0]).toMatchObject({ locked: true, color: '#ff0000', featherFalloff: 'linear', motionBlur: 'on' });
    }
    // A wrong choice is refused with the allowed values.
    await expect(h.run({ type: 'setProperty', prop: { layer: s.A, path: `masks/${s.mask}/motionBlur` }, value: { kind: 'choice', value: 'sometimes' } }))
      .rejects.toThrow(/sameAsLayer, on, off/);
  });
});
