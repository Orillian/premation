import { computeWorldTransforms, boneTip } from '@core/rig/skeleton';
import { validateRig } from '@core/rig/rigPresets';
import { buildRig, cycleKeys, defaultBipedJoints, niceStep, poleFor, solveLocal, worldDeg, type Pt } from './rigTools';

const close = (a: Pt, b: Pt): void => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
};

describe('solveLocal', () => {
  it('places every root and tip on the world joints it was given, through rotated parents', () => {
    const bones = solveLocal([
      { id: 'a', name: 'a', parent: null, root: { x: 0, y: 100 }, tip: { x: 0, y: -50 } },
      { id: 'b', name: 'b', parent: 'a', root: { x: -60, y: -40 }, tip: { x: -110, y: 30 } },
      { id: 'c', name: 'c', parent: 'b', root: { x: -110, y: 30 }, tip: { x: -120, y: 110 } },
    ]);
    const world = computeWorldTransforms({ bones });
    const at = (id: string): { root: Pt; tip: Pt } => {
      const m = world.get(id)!;
      const len = bones.find((b) => b.id === id)!.length;
      return { root: { x: m[4], y: m[5] }, tip: boneTip(m, len) };
    };
    close(at('a').root, { x: 0, y: 100 });
    close(at('a').tip, { x: 0, y: -50 });
    close(at('b').root, { x: -60, y: -40 });
    close(at('b').tip, { x: -110, y: 30 });
    close(at('c').tip, { x: -120, y: 110 });
  });
});

describe('buildRig', () => {
  const box = { x: -130, y: -210, width: 260, height: 420 };

  it('builds a valid biped whose limbs end on their joints, with IK goals there', () => {
    const joints = defaultBipedJoints(box);
    const rig = buildRig({ biped: joints, chains: [], centreX: 0 });
    expect(validateRig(rig)).toEqual([]);
    const world = computeWorldTransforms(rig);
    const tip = (id: string): Pt => boneTip(world.get(id)!, rig.bones.find((b) => b.id === id)!.length);
    close(tip('arm_l_lower'), joints.wrist_l);
    close(tip('leg_r_lower'), joints.ankle_r);
    close(tip('head'), joints.head_top);
    expect(rig.ikTargets!.map((g) => g.boneId).sort()).toEqual(['arm_l_lower', 'arm_r_lower', 'leg_l_lower', 'leg_r_lower']);
    const goal = rig.ikTargets!.find((g) => g.boneId === 'arm_l_lower')!;
    close(goal, joints.wrist_l);
  });

  it('adds chains hung from a bone, with IK at the tip when asked', () => {
    const rig = buildRig({
      biped: defaultBipedJoints(box),
      chains: [{ name: 'tail', parent: 'hips', ik: true, points: [{ x: 20, y: 10 }, { x: 80, y: 30 }, { x: 140, y: 20 }] }],
      centreX: 0,
    });
    expect(validateRig(rig)).toEqual([]);
    expect(rig.bones.find((b) => b.id === 'tail_1')!.parentId).toBe('hips');
    expect(rig.ikTargets!.find((g) => g.boneId === 'tail_2')).toMatchObject({ x: 140, y: 20, chainLength: 2 });
  });
});

describe('poleFor', () => {
  it('keeps the side a bent joint already bends to', () => {
    const p = poleFor({ x: 0, y: 0 }, { x: 20, y: 50 }, { x: 0, y: 100 }, -1);
    expect(p.x).toBeGreaterThan(20);
  });
  it('bends a straight chain away from the centre line', () => {
    expect(poleFor({ x: -40, y: 0 }, { x: -40, y: 50 }, { x: -40, y: 100 }, -1).x).toBeLessThan(-40);
    expect(poleFor({ x: 40, y: 0 }, { x: 40, y: 50 }, { x: 40, y: 100 }, 1).x).toBeGreaterThan(40);
  });
});

describe('niceStep', () => {
  it('rounds to 1 / 2 / 2.5 / 5 × 10ⁿ', () => {
    expect(niceStep(420)).toBe(50);
    expect(niceStep(1000)).toBe(100);
    expect(niceStep(180)).toBe(20);
  });
});

describe('cycleKeys', () => {
  const rig = buildRig({ biped: defaultBipedJoints({ x: -130, y: -210, width: 260, height: 420 }), chains: [], centreX: 0 });

  it('idle breathes on chest, head and hips over the span', () => {
    const keys = cycleKeys(rig, { cycle: 'idle', startSec: 1, durationSec: 6, periodSec: 3, amount: 1, side: 'r', height: 420 });
    expect(new Set(keys.map((k) => k.prop))).toEqual(new Set(['bone.chest.rotation', 'bone.head.rotation', 'bone.hips.y']));
    expect(Math.min(...keys.map((k) => k.t))).toBeCloseTo(1, 6);
    expect(Math.max(...keys.map((k) => k.t))).toBeCloseTo(7, 6);
  });

  it('wave raises the arm up and out in world space', () => {
    const keys = cycleKeys(rig, { cycle: 'wave', startSec: 0, durationSec: 1.6, periodSec: 0.8, amount: 1, side: 'r', height: 420 });
    const upper = keys.find((k) => k.prop === 'bone.arm_r_upper.rotation')!;
    const parent = worldDeg(rig, 'chest');
    expect(parent + upper.value).toBeCloseTo(-50, 4);
  });

  it('walk lifts each foot goal in turn', () => {
    const keys = cycleKeys(rig, { cycle: 'walk', startSec: 0, durationSec: 1, periodSec: 1, amount: 1, side: 'r', height: 420 });
    const l = keys.filter((k) => k.prop === 'ikTarget.leg_l_lower.y').map((k) => k.value);
    const r = keys.filter((k) => k.prop === 'ikTarget.leg_r_lower.y').map((k) => k.value);
    expect(Math.min(...l)).toBeLessThan(Math.max(...l));
    expect(l.indexOf(Math.min(...l))).not.toBe(r.indexOf(Math.min(...r)));
  });
});
