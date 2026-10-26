/**
 * The graph editor's local curve for a SPATIAL member agrees with the engine.
 *
 * While a drag outruns the engine's `sampleProperty` answer the graph draws
 * the moving segment from the keys. For Position that used to be the axis's
 * own temporal bezier — a curve the engine never evaluates once the motion
 * path bends, because the engine moves along the path at constant speed in
 * arc length. The local sampler now reads the sibling axes and times the
 * segment the engine's way; this checks the two against each other on the
 * real engine, with the per-axis answer shown to be the wrong one.
 */

import { cubicValueAt } from '@motion/animation';
import { documentMirror } from '@stores/documentMirror';
import { storedTimeOf } from '@core/mirror/keySelection';
import { memberKeysOf } from '@core/mirror/memberKeys';
import { clearHistory, setupAppEngine, settleEdits, sec, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { memberPropertyTrack, sampleMemberLocal, spatialSiblingTracks, isSpatialTrackRef } from './graphLocalSample';

let h: Harness;
let NODE = '';

beforeEach(async () => {
  h = await setupAppEngine({ panels: true });
  NODE = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'P', init: [] })).layer;
  // (0, 0) → (100, 0) over one second; the out tangent dives +100 in y, the
  // in tangent is folded onto the end key — a lopsided arc (the same curve
  // packages/animation's arc-length tests measure).
  await h.run({
    type: 'addKeyframes',
    keys: [
      { prop: { layer: NODE, path: 'transform/position' }, time: sec(0), value: { kind: 'vec2', value: { x: 0, y: 0 } }, easing: 'linear', spatialInterp: 'bezier', spatialIn: [], spatialOut: [0, 100] },
      { prop: { layer: NODE, path: 'transform/position' }, time: sec(1), value: { kind: 'vec2', value: { x: 100, y: 0 } }, easing: 'linear', spatialInterp: 'bezier', spatialIn: [0, 0], spatialOut: [] },
    ],
  });
  await clearHistory();
  await settleEdits();
});

afterEach(async () => {
  await h.dispose();
});

/** The engine's evaluated position at comp second `t`, [x, y]. */
async function engineAt(t: number): Promise<number[]> {
  const r = await h.query({
    type: 'sampleProperty',
    prop: { layer: NODE, path: 'transform/position' },
    range: { start: sec(t), duration: sec(0.25) },
    samples: 2,
    speed: false,
  });
  return r.values.slice(0, r.dimensions);
}

it('the local midpoint of each axis is the engine’s, not the per-axis bezier-u value', async () => {
  const m = documentMirror();
  const storedT = storedTimeOf(NODE);
  const x = memberKeysOf(m, NODE, 'x', storedT)!;
  expect(x.keys).toHaveLength(2);
  expect(isSpatialTrackRef(x.ref)).toBe(true);
  // The tangent came through the mirror in this dimension's slot.
  expect(x.keys[0]!.key.spatialOut).toEqual([0, 100]);

  const siblings = spatialSiblingTracks(m, NODE, x.ref, storedT)!;
  expect(siblings).toHaveLength(x.ref.members.length);
  const want = await engineAt(0.5);

  for (const [axis, member] of [[0, 'x'], [1, 'y']] as const) {
    const hit = memberKeysOf(m, NODE, member, storedT)!;
    const own = memberPropertyTrack(NODE, member, hit.ref, hit.keys, axis);
    const local = sampleMemberLocal(own, siblings, axis, 0.5)!;
    expect(local).toBeCloseTo(want[axis]!, 6);

    // What the old per-axis sampling gave: the axis's own cubic at u = ½ —
    // linear ease, so u is the time fraction. Off by whole pixels.
    const [a, b] = hit.keys as [typeof hit.keys[0], typeof hit.keys[0]];
    const so = a.key.spatialOut[axis]!;
    const si = b.key.spatialIn[axis]!;
    const perAxis = cubicValueAt(a.value, a.value + so, b.value + si, b.value, 0.5);
    expect(Math.abs(local - perAxis)).toBeGreaterThan(1);
  }
});

it('a straight motion path is sampled as before — the axis alone', async () => {
  // A second, straight segment well away from the curved one: corners at both ends, no tangents.
  await h.run({
    type: 'addKeyframes',
    keys: [3, 4].map((t) => ({
      prop: { layer: NODE, path: 'transform/position' }, time: sec(t), value: { kind: 'vec2' as const, value: { x: 100, y: (t - 3) * 50 } },
      easing: 'linear' as const, spatialInterp: 'linear' as const, spatialIn: [], spatialOut: [],
    })),
  });
  await settleEdits();
  const m = documentMirror();
  const storedT = storedTimeOf(NODE);
  const y = memberKeysOf(m, NODE, 'y', storedT)!;
  const siblings = spatialSiblingTracks(m, NODE, y.ref, storedT)!;
  const own = memberPropertyTrack(NODE, 'y', y.ref, y.keys, 1);
  // Segment 3 → 4 s: y 0 → 50 on a straight line — 25 at 3.5 s, the engine's number.
  const local = sampleMemberLocal(own, siblings, 1, 3.5)!;
  expect(local).toBeCloseTo(25, 6);
  expect(local).toBeCloseTo((await engineAt(3.5))[1]!, 6);
});
