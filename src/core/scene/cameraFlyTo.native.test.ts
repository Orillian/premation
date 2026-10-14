/**
 * R4: Fly to Selected Layers — from the playhead, keys that travel to each
 * layer (selection order) and hold on it, as ONE undo entry; at every hold
 * the layer sits in the centre of the frame, for a two-node camera (Position
 * + Point of Interest) and a one-node one (Position, rotation kept).
 */

import type { Value } from '@motion/engine-api';
import { Project3D, type Vec3 } from '@motion/scene';
import { clearHistory, setupAppEngine, historyLabels, sec } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { propRefForTrack } from '@core/engine/propRefs';
import { layerWorldPosition, resolveCommandCamera } from './cameraCommands';
import { flyToLayersEdit, flyToTimes, unorbit } from './cameraFlyTo';

let h: Harness;
let A = '';
let B = '';

const vec3 = (x: number, y: number, z: number): Value => ({ kind: 'vec3', value: { x, y, z } });

async function solid3D(name: string, p: Vec3): Promise<string> {
  const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name, init: [] });
  await h.run({ type: 'setLayerSwitches', layers: [layer], patch: { threeD: true } });
  await h.run({ type: 'setProperty', prop: { layer, path: 'transform/position' }, value: vec3(p.x, p.y, p.z) });
  return layer;
}

async function camera(twoNode: boolean): Promise<string> {
  const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'camera', name: 'Fly camera', init: [] });
  if (twoNode) await h.run({ type: 'setProperty', prop: { layer, path: 'transform/orientTowardsPointOfInterest' }, value: { kind: 'bool', value: true } });
  await engineIdle();
  await documentMirror().loadTree(layer);
  await clearHistory();
  return layer;
}

beforeEach(async () => {
  h = await setupAppEngine();
  A = await solid3D('A', { x: 300, y: 250, z: 400 });
  B = await solid3D('B', { x: 1500, y: 800, z: -200 });
  await engineIdle();
});
afterEach(async () => { await h.dispose(); });

/** Where `layer`'s anchor lands on screen through the camera at `t`. */
async function onScreen(cam: string, layer: string, t: number): Promise<{ x: number; y: number }> {
  const [rig, p] = await Promise.all([resolveCommandCamera(cam, t), layerWorldPosition(layer, t)]);
  const o = Project3D.projectPoint(p!, rig!.camera);
  return { x: o.x, y: o.y };
}

describe('fly-to timing and orbit inverse (pure)', () => {
  it('arrive / leave per layer', () => {
    expect(flyToTimes(2, 0, { travel: 1, hold: 1 })).toEqual({ arrive: 3, leave: 4 });
    expect(flyToTimes(2, 1, { travel: 1, hold: 1 })).toEqual({ arrive: 5, leave: 6 });
    expect(flyToTimes(0, 2, { travel: 0.5, hold: 2 })).toEqual({ arrive: 5.5, leave: 7.5 });
  });
  it('unorbit undoes orbitCamera', () => {
    const centre = { x: 960, y: 540, z: 0 };
    const eye = { x: 100, y: -300, z: -2000 };
    const base = unorbit(eye, centre, 25, -10);
    const back = Project3D.orbitCamera(base, centre, 25, -10).position;
    expect(back.x).toBeCloseTo(eye.x, 6);
    expect(back.y).toBeCloseTo(eye.y, 6);
    expect(back.z).toBeCloseTo(eye.z, 6);
  });
});

describe('Fly to Selected Layers', () => {
  it.each([true, false])('two-node %s: keys at the expected times, each layer centred at its hold, ONE entry', async (twoNode) => {
    const cam = await camera(twoNode);
    const res = await flyToLayersEdit(cam, [A, B], 1, { travel: 1, hold: 1 });
    expect(res).toEqual({ ok: true, end: 5, keys: twoNode ? 20 : 5 });
    await engineIdle();
    await documentMirror().whenIdle();
    const posPath = propRefForTrack(cam, 'x')!.ref.path;
    const times = documentMirror().keyframes(cam, posPath).map((k) => k.time);
    expect(times).toEqual([sec(1), sec(2), sec(3), sec(4), sec(5)]);
    if (twoNode) {
      for (const t of ['poiX', 'poiY', 'poiZ']) expect(documentMirror().keyframes(cam, propRefForTrack(cam, t)!.ref.path).map((k) => k.time)).toEqual(times);
    }
    for (const [layer, t] of [[A, 2], [A, 3], [B, 4], [B, 5]] as const) {
      const p = await onScreen(cam, layer, t);
      expect({ layer, t, x: Math.round(p.x), y: Math.round(p.y) }).toEqual({ layer, t, x: 960, y: 540 });
    }
    expect(await historyLabels()).toEqual(['Fly to Selected Layers']);
  });

  it('starts from the shot as it is', async () => {
    const cam = await camera(true);
    const before = (await resolveCommandCamera(cam, 0))!.camera.position;
    await flyToLayersEdit(cam, [A], 0, { travel: 2, hold: 0.5 });
    await engineIdle();
    const at0 = (await resolveCommandCamera(cam, 0))!.camera.position;
    expect(at0.x).toBeCloseTo(before.x, 3);
    expect(at0.z).toBeCloseTo(before.z, 3);
  });
});
