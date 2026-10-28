/**
 * Subject track through the engine: a null keyed on the matte outline's
 * centroid (comp space), its height as Scale, its top as a Point Control.
 */

import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels, sec, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import { paths } from '@core/engine/propRefs';
import { documentMirror } from '@stores/documentMirror';
import { createSubjectTrackEdit, outlineStats } from './subjectTrack';

let h: Harness;
let s: Scene;

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
});

afterEach(async () => {
  await h.dispose();
});

const rect = (x0: number, y0: number, x1: number, y1: number) => ({
  vertices: [x0, y0, x1, y0, x1, y1, x0, y1], inTangents: [], outTangents: [], closed: true, featherPoints: [], vertexStates: [],
});

it('finds a polygon centroid and box', () => {
  expect(outlineStats([0, 0, 10, 0, 10, 20, 0, 20])).toEqual({ cx: 5, cy: 10, x0: 0, y0: 0, x1: 10, y1: 20 });
  expect(outlineStats([0, 0, 1, 1])).toBeNull();
});

it('keys a null on the subject, one entry', async () => {
  const { groups: [g] } = await h.run({ type: 'addMask', layer: s.V, mode: 'none', inverted: false, name: 'Object Matte', path: rect(-50, -100, 50, 100) });
  const mask = g!.split('/')[1]!;
  await h.run({
    type: 'addKeyframes',
    keys: [
      { prop: { layer: s.V, path: paths.mask(mask, 'path') }, time: 0, value: { kind: 'path', value: rect(-50, -100, 50, 100) }, spatialIn: [], spatialOut: [] },
      { prop: { layer: s.V, path: paths.mask(mask, 'path') }, time: sec(1), value: { kind: 'path', value: rect(50, -50, 150, 150) }, spatialIn: [], spatialOut: [] },
    ],
  });
  await engineIdle();
  const entries = (await historyLabels()).length;
  const r = await createSubjectTrackEdit(s.V);
  await engineIdle();
  if (!r.ok) throw new Error(r.message);
  expect(r.keys).toBe(2);
  expect((await historyLabels()).length).toBe(entries + 1);

  const m = documentMirror();
  expect(m.layer(r.nullId)?.kind).toBe('null');
  const at0 = (await h.query({ type: 'getLayerTransforms', layers: [s.V], time: 0 })).transforms[0]!.matrix;
  const pos = m.keyframes(r.nullId, paths.transform('position'));
  expect(pos).toHaveLength(2);
  const p0 = pos[0]!.value;
  if (p0.kind !== 'vec2') throw new Error(p0.kind);
  // Centroid (0, 0) of the first outline, through the layer's matrix.
  expect(p0.value.x).toBeCloseTo(at0[12]!, 3);
  expect(p0.value.y).toBeCloseTo(at0[13]!, 3);
  const sc = m.keyframes(r.nullId, paths.transform('scale'));
  const s0 = sc[0]!.value;
  const s1 = sc[1]!.value;
  if (s0.kind !== 'vec2' || s1.kind !== 'vec2') throw new Error('scale');
  expect(s0.value.x).toBeCloseTo(100, 3);
  // The subject's box is the same height at 1 s.
  expect(s1.value.x).toBeCloseTo(100, 3);
});

it('says so when the layer has no matte through the shot', async () => {
  const r = await createSubjectTrackEdit(s.V);
  expect(r.ok).toBe(false);
});
