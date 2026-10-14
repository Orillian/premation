/**
 * R3a: Camera ▸ Follow Path — a mask (or shape) path becomes the camera's
 * Position keys as ONE undo entry: one key per vertex ON the path (world
 * space, the camera keeping its Z for a 2D layer), the path's handles as
 * spatial tangents, the ends fixed and every key between them roving, the
 * times spread by arc length over the range.
 */

import type { Keyframe } from '@motion/engine-api';
import { clearHistory, setupAppEngine, historyLabels, sec } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { flicksToSeconds } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';
import { propRefForTrack } from '@core/engine/propRefs';
import { followPathEdit, pathPositionKeys, segmentLengths } from './cameraFollowPath';

let h: Harness;
let CAM = '';
let SOLID = '';

/** An open L: (0,0) → (400,0) → (400,300) in the solid's layer space, the middle corner rounded by handles. */
const PATH = {
  vertices: [0, 0, 400, 0, 400, 300],
  inTangents: [0, 0, -100, 0, 0, 0],
  outTangents: [0, 0, 0, 100, 0, 0],
  closed: false, featherPoints: [], vertexStates: [],
};

beforeEach(async () => {
  h = await setupAppEngine();
  ({ layer: CAM } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'camera', name: 'Path camera', init: [] }));
  ({ layer: SOLID } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'Route', init: [] }));
  // Layer space = comp space shifted by (100, 200): anchor at the origin.
  await h.run({ type: 'setProperty', prop: { layer: SOLID, path: 'transform/anchorPoint' }, value: { kind: 'vec2', value: { x: 0, y: 0 } } });
  await h.run({ type: 'setProperty', prop: { layer: SOLID, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 100, y: 200 } } });
  await h.run({ type: 'addMask', layer: SOLID, mode: 'add', inverted: false, path: PATH });
  await engineIdle();
  await documentMirror().loadTree(CAM);
  await documentMirror().loadTree(SOLID);
  await clearHistory();
});
afterEach(async () => { await h.dispose(); });

function positionKeys(): readonly Keyframe[] {
  const r = propRefForTrack(CAM, 'x');
  return r ? documentMirror().keyframes(CAM, r.ref.path) : [];
}

describe('pathPositionKeys (pure)', () => {
  it('a closed path ends where it began, through the closing segment', () => {
    const sq = {
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, { x: 100, y: 100, z: 0 }, { x: 0, y: 100, z: 0 }],
      inTangents: Array.from({ length: 4 }, () => ({ x: 0, y: 0, z: 0 })),
      outTangents: Array.from({ length: 4 }, () => ({ x: 0, y: 0, z: 0 })),
      closed: true,
    };
    expect(segmentLengths(sq).map((l) => Math.round(l))).toEqual([100, 100, 100, 100]);
    const keys = pathPositionKeys(sq, 0, 4, -500);
    expect(keys).toHaveLength(5);
    expect(keys.map((k) => Math.round(flicksToSeconds(k.time) * 1000) / 1000)).toEqual([0, 1, 2, 3, 4]);
    expect(keys[4]!.value).toEqual({ kind: 'vec3', value: { x: 0, y: 0, z: -500 } });
    expect(keys.map((k) => k.roving)).toEqual([false, true, true, true, false]);
  });
});

describe('Follow Path', () => {
  it('writes one key per vertex on the path, roving between fixed ends, as ONE entry', async () => {
    const zBefore = (await h.query({ type: 'getPropertyValues', props: [propRefForTrack(CAM, 'x')!.ref], time: 0, evaluated: true })).values[0]?.value;
    const res = await followPathEdit(CAM, SOLID, 1, 5);
    expect(res).toEqual({ ok: true, keys: 3 });
    await engineIdle();
    await documentMirror().whenIdle();
    const keys = positionKeys();
    expect(keys).toHaveLength(3);
    const z = zBefore?.kind === 'vec3' ? zBefore.value.z : NaN;
    // ON the path: each vertex through the layer's transform, at the camera's own depth.
    const want = [{ x: 100, y: 200 }, { x: 500, y: 200 }, { x: 500, y: 500 }];
    keys.forEach((k, i) => {
      expect(k.value.kind).toBe('vec3');
      if (k.value.kind !== 'vec3') return;
      expect(k.value.value.x).toBeCloseTo(want[i]!.x, 3);
      expect(k.value.value.y).toBeCloseTo(want[i]!.y, 3);
      expect(k.value.value.z).toBeCloseTo(z, 3);
    });
    // The fixed ends span the range; the middle key roves.
    expect(keys[0]!.time).toBe(sec(1));
    expect(keys[2]!.time).toBe(sec(5));
    expect(keys.map((k) => k.roving)).toEqual([false, true, false]);
    // The rounded corner's handles are the middle key's spatial tangents.
    expect(keys[1]!.spatialIn.slice(0, 2)).toEqual([-100, 0]);
    expect(keys[1]!.spatialOut.slice(0, 2)).toEqual([0, 100]);
    expect(await historyLabels()).toEqual(['Follow Path']);
  });

  it('refuses a layer with no path, and writes nothing', async () => {
    const { layer: plain } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'null', name: 'Nothing', init: [] });
    await clearHistory();
    const res = await followPathEdit(CAM, plain, 0, 2);
    expect(res.ok).toBe(false);
    expect(positionKeys()).toHaveLength(0);
    expect(await historyLabels()).toEqual([]);
  });
});
