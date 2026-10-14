/**
 * R2: camera rigs — Add Camera Rig builds the named, parented 3D nulls above
 * the camera as ONE undo entry without moving the shot; the Camera Rig
 * section's sliders move the camera's world position the way the control
 * says; Undo removes every null.
 *
 * On the app's engine: the camera's world eye is read the way the renderer
 * resolves it (`resolveCommandCamera`: its props, lifted through the parent
 * chain's world matrices from `getLayerTransforms`).
 */

import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import type { Vec3 } from '@motion/scene';
import { clearHistory, setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { uiKindOf } from '@core/mirror/layerKinds';
import { CameraRigSection } from '@layout/Inspector/CameraRigSection';
import { resolveCommandCamera } from './cameraCommands';
import { RIG_NULLS, addCameraRigEdit, armValues, parseRigNullName, rigNullName, rigOf } from './cameraRig';

jest.useFakeTimers();

let h: Harness;
let CAM = '';

beforeEach(async () => {
  h = await setupAppEngine();
  usePreferenceStore.getState().set('timelineAutoKeyframe', false);
  usePreferenceStore.getState().set('inspectorSections', {});
  await act(async () => {
    ({ layer: CAM } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'camera', name: 'Rig camera', init: [] }));
    // Two-node: the rig carries the Point of Interest with the eye.
    await h.run({ type: 'setProperty', prop: { layer: CAM, path: 'transform/orientTowardsPointOfInterest' }, value: { kind: 'bool', value: true } });
    await engineIdle();
    await documentMirror().loadTree(CAM);
  });
  await clearHistory();
  useSelectionStore.setState({ ids: [CAM] } as never);
});
afterEach(async () => {
  cleanup();
  await h.dispose();
});

const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); await documentMirror().whenIdle(); }); };
const settle = (): void => { act(() => { jest.advanceTimersByTime(2000); }); };

async function eye(): Promise<Vec3> {
  const rig = await resolveCommandCamera(CAM, 0);
  if (!rig) throw new Error('no camera');
  return rig.camera.position;
}

function expectNear(a: Vec3, b: Vec3, digits = 3): void {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
  expect(a.z).toBeCloseTo(b.z, digits);
}

async function addRig(kind: 'crane' | 'dolly' | 'orbit'): Promise<string[]> {
  let ids: string[] | null = null;
  await act(async () => { ids = await addCameraRigEdit(CAM, kind, 0); });
  await idle();
  if (!ids) throw new Error('rig refused');
  for (const id of ids as string[]) await act(async () => { await documentMirror().loadTree(id); });
  await act(async () => { await documentMirror().loadTree(CAM); });
  return ids;
}

function field(name: string): HTMLElement {
  return screen.getByRole('spinbutton', { name });
}

async function setField(name: string, value: number): Promise<void> {
  const el = field(name);
  fireEvent.keyDown(el, { key: 'Enter' });
  const input = el.querySelector('input');
  if (!input) throw new Error(`ValueField "${name}" did not open an input on Enter`);
  fireEvent.change(input, { target: { value: String(value) } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await idle();
}

describe('rig names', () => {
  it('round-trip', () => {
    expect(rigNullName('crane', 'Boom')).toBe('Rig · Crane · Boom');
    expect(parseRigNullName('Rig · Orbit · Pivot')).toEqual({ kind: 'orbit', control: 'Pivot' });
    expect(parseRigNullName('Boom')).toBeNull();
  });
  it('the arm scales along its own direction', () => {
    expect(armValues({ x: 3, y: 0, z: 4 }, 10)).toEqual({ x: 6, y: 0, z: 8 });
    expect(armValues({ x: 0, y: 0, z: 0 }, 5)).toEqual({ x: 0, y: 0, z: 5 });
  });
});

describe('Add Camera Rig', () => {
  it.each(['crane', 'dolly', 'orbit'] as const)('%s: chained 3D nulls above the camera, nothing moves, ONE entry, Undo removes all', async (kind) => {
    const before = await eye();
    const ids = await addRig(kind);
    const m = documentMirror();
    expect(ids.map((id) => m.layer(id)?.name)).toEqual(RIG_NULLS[kind].map((c) => rigNullName(kind, c)));
    for (const [i, id] of ids.entries()) {
      expect(uiKindOf(m.layer(id))).toBe('null');
      expect(m.layer(id)?.switches.threeD).toBe(true);
      expect(m.layer(id)?.parent ?? null).toBe(i === 0 ? null : ids[i - 1]);
    }
    expect(m.layer(CAM)?.parent).toBe(ids[ids.length - 1]);
    expectNear(await eye(), before, 2);
    // The rig reads back from the camera and from each of its nulls.
    for (const id of [CAM, ...ids]) expect(rigOf(id)?.camera).toBe(CAM);
    settle();
    expect(await historyLabels()).toHaveLength(1);

    await act(async () => { await h.run({ type: 'undo' }); });
    await idle();
    for (const id of ids) expect(documentMirror().layer(id)).toBeUndefined();
    expect(documentMirror().layer(CAM)?.parent ?? null).toBeNull();
    expectNear(await eye(), before, 2);
  });
});

describe('the Camera Rig sliders', () => {
  it('dolly: Truck / Pedestal / Dolly move the camera by exactly that much in world space', async () => {
    await addRig('dolly');
    const before = await eye();
    render(<CameraRigSection nodeId={CAM} />);
    // The track sits under the camera (the camera's own offset is 0), so the
    // eye lands exactly where the slider puts the track.
    expect(Number(field('Truck').getAttribute('aria-valuenow'))).toBe(Math.round(before.x));
    expect(Number(field('Pedestal').getAttribute('aria-valuenow'))).toBe(0);
    await setField('Truck', Math.round(before.x) + 100);
    expect((await eye()).x).toBeCloseTo(Math.round(before.x) + 100, 3);
    await setField('Pedestal', -50);
    expect((await eye()).y).toBeCloseTo(before.y - 50, 3);
    const dolly = Number(field('Dolly').getAttribute('aria-valuenow'));
    await setField('Dolly', dolly + 200);
    expectNear(await eye(), { x: Math.round(before.x) + 100, y: before.y - 50, z: dolly + 200 }, 3);
    settle();
    expect(await historyLabels()).toHaveLength(4);
  });

  it('crane: Swing carries the camera on an arc around the base; Arm sets its reach', async () => {
    const ids = await addRig('crane');
    const before = await eye();
    const reach = Math.round(1920 * 0.25);
    render(<CameraRigSection nodeId={ids[1]!} />);
    expect(Number(field('Arm').getAttribute('aria-valuenow'))).toBe(reach);
    // The base sits a boom-length behind the camera; a 90° swing puts the
    // camera beside it, a boom-length away, at the base's depth.
    await setField('Swing', 90);
    const swung = await eye();
    const base = { x: before.x, y: before.y, z: before.z - reach };
    expect(Math.hypot(swung.x - base.x, swung.z - base.z)).toBeCloseTo(reach, 0);
    expect(swung.z).toBeCloseTo(base.z, 0);
    expect(swung.y).toBeCloseTo(before.y, 1);
    await setField('Swing', 0);
    await setField('Arm', reach * 2);
    expectNear(await eye(), { x: before.x, y: before.y, z: before.z + reach }, 0);
  });

  it('orbit: Swing keeps the camera its distance from the target', async () => {
    const ids = await addRig('orbit');
    const pivot = documentMirror().layer(ids[0]!);
    expect(pivot?.name).toBe('Rig · Orbit · Pivot');
    render(<CameraRigSection nodeId={CAM} />);
    const before = await eye();
    const arm = Number(field('Arm').getAttribute('aria-valuenow'));
    await setField('Swing', 45);
    const after = await eye();
    expect(after.x).not.toBeCloseTo(before.x, 0);
    // The target is the comp centre (the two-node default POI).
    expect(Math.hypot(after.x - 960, after.y - 540, after.z)).toBeCloseTo(arm, 0);
  });
});
