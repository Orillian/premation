/**
 * The gizmo on cameras and lights (deviceGizmo.ts): a move carries the point
 * of interest along, a Z turn aims an untargeted spot / parallel light, a
 * camera's rings write its Orientation, and scale handles write nothing.
 */

import { deviceCanRotate, deviceGizmoValues, lightHasDirection, type DeviceGizmoState } from './deviceGizmo';

const base = (over: Partial<DeviceGizmoState> = {}): DeviceGizmoState => ({
  device: 'light',
  lightType: 'spot',
  world: { x: 100, y: 200, z: -300 },
  poi: null,
  parent: [],
  lightAngle: 30,
  orientation: { x: 0, y: 0, z: 0 },
  ...over,
});

const noRot = { x: 0, y: 0, z: 0 };

describe('deviceGizmoValues', () => {
  it('a position handle moves the device by the world delta', () => {
    const v = deviceGizmoValues(base(), 'pos_x', { delta: { x: 10, y: 0, z: 0 }, rot: noRot });
    expect(v).toEqual({ x: 110, y: 200, z: -300 });
  });

  it('…and its point of interest with it, so the aim is kept', () => {
    const v = deviceGizmoValues(base({ device: 'camera', lightType: '', poi: { x: 500, y: 500, z: 0 } }), 'plane_xy', { delta: { x: 10, y: -20, z: 0 }, rot: noRot });
    expect(v).toEqual({ x: 110, y: 180, z: -300, poiX: 510, poiY: 480, poiZ: 0 });
  });

  it('a parented device writes parent-space values', () => {
    // Parent translated by (1000, 0, 0): world 100 → local -900.
    const parent = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1000, 0, 0, 1];
    const v = deviceGizmoValues(base({ parent }), 'pos_z', { delta: { x: 0, y: 0, z: 50 }, rot: noRot });
    expect(v.x).toBeCloseTo(-900);
    expect(v.z).toBeCloseTo(-250);
  });

  it('the Z ring turns a spot light with no target; X / Y rings do not', () => {
    expect(deviceGizmoValues(base(), 'rot_z', { delta: noRot, rot: { x: 0, y: 0, z: 15 } })).toEqual({ lightAngle: 45 });
    expect(deviceGizmoValues(base(), 'rot_x', { delta: noRot, rot: { x: 15, y: 0, z: 0 } })).toEqual({});
  });

  it('a targeted light and a point light have no direction to turn', () => {
    expect(deviceGizmoValues(base({ poi: { x: 0, y: 0, z: 0 } }), 'rot_z', { delta: noRot, rot: { x: 0, y: 0, z: 15 } })).toEqual({});
    expect(deviceGizmoValues(base({ lightType: 'point' }), 'rot_z', { delta: noRot, rot: { x: 0, y: 0, z: 15 } })).toEqual({});
    expect(lightHasDirection(base({ lightType: 'parallel' }))).toBe(true);
    expect(lightHasDirection(base({ lightType: 'point' }))).toBe(false);
  });

  it('a camera\'s rings write its Orientation, one axis each', () => {
    const cam = base({ device: 'camera', lightType: '', orientation: { x: 1, y: 2, z: 3 } });
    expect(deviceGizmoValues(cam, 'rot_x', { delta: noRot, rot: { x: 10, y: 0, z: 0 } })).toEqual({ orientationX: 11 });
    expect(deviceGizmoValues(cam, 'rot_y', { delta: noRot, rot: { x: 0, y: 10, z: 0 } })).toEqual({ orientationY: 12 });
    expect(deviceGizmoValues(cam, 'rot_z', { delta: noRot, rot: { x: 0, y: 0, z: 10 } })).toEqual({ orientationZ: 13 });
    expect(deviceCanRotate(cam)).toBe(true);
  });

  it('scale handles write nothing for a device', () => {
    expect(deviceGizmoValues(base(), 'scale_x', { delta: noRot, rot: noRot })).toEqual({});
    expect(deviceGizmoValues(base(), 'scale_center', { delta: noRot, rot: noRot })).toEqual({});
  });
});
