/**
 * The 3D transform gizmo on CAMERAS and LIGHTS (U4 of docs/PROGRAM_3D_PERF_UX.md).
 *
 * A device has no layer transform: a camera is a position (its lens) and,
 * two-node, a point of interest; a light a position, optionally a point of
 * interest, and — spot and parallel without one — a direction (`lightAngle`,
 * degrees in the comp plane). So the gizmo's handles map onto those props:
 *
 *   • position arrows / planes move the device AND its point of interest by
 *     the same world delta (as dragging the layer does in After Effects — the
 *     shot keeps its aim; the POI grab dot alone re-aims it);
 *   • the Z rotation ring turns a spot / parallel light with no target
 *     (`lightAngle`), and a camera's rings write its Orientation;
 *   • scale handles do nothing — a device has no size.
 *
 * Pure: the drag-start state in, the absolute values to write out. The hook
 * (useGizmo3d) feeds them to the same `trackValueCommands` path the layers use,
 * so keyframing and undo behave exactly as for a layer.
 */

import type { Vec3 } from '@motion/scene';
import { toParentSpace } from '@core/mirror/viewGeometry';

export interface DeviceGizmoState {
  device: 'camera' | 'light';
  /** readNodeLight's type for a light ('' for a camera). */
  lightType: string;
  /** World position at grab time. */
  world: Vec3;
  /** World point of interest at grab time; null for a one-node camera / an untargeted light. */
  poi: Vec3 | null;
  /** The parent chain's world matrix (empty = none). */
  parent: readonly number[];
  /** A light's stored direction at grab time, degrees. */
  lightAngle: number;
  /** A camera's stored Orientation at grab time, degrees. */
  orientation: { x: number; y: number; z: number };
}

export interface DeviceGizmoMove {
  /** World delta of a position handle. */
  delta: Vec3;
  /** Degrees turned on each rotation ring. */
  rot: { x: number; y: number; z: number };
}

/** A light whose aim is a direction rather than a target. */
export function lightHasDirection(st: Pick<DeviceGizmoState, 'device' | 'lightType' | 'poi'>): boolean {
  return st.device === 'light' && st.poi === null && (st.lightType === 'spot' || st.lightType === 'parallel');
}

/** Whether the gizmo's rotation rings do anything for this device. */
export function deviceCanRotate(st: Pick<DeviceGizmoState, 'device' | 'lightType' | 'poi'>): boolean {
  return st.device === 'camera' || lightHasDirection(st);
}

/**
 * The absolute values a gizmo handle writes for a device. Only the handle's
 * own props, as for a layer: a move never touches the aim, a turn never the
 * position, and nothing is written for a scale handle.
 */
export function deviceGizmoValues(st: DeviceGizmoState, handle: string, move: DeviceGizmoMove): Record<string, number> {
  const values: Record<string, number> = {};
  if (handle.startsWith('pos_') || handle.startsWith('plane_')) {
    const p = toParentSpace(st.parent, { x: st.world.x + move.delta.x, y: st.world.y + move.delta.y, z: st.world.z + move.delta.z });
    values.x = p.x; values.y = p.y; values.z = p.z;
    if (st.poi) {
      const q = toParentSpace(st.parent, { x: st.poi.x + move.delta.x, y: st.poi.y + move.delta.y, z: st.poi.z + move.delta.z });
      values.poiX = q.x; values.poiY = q.y; values.poiZ = q.z;
    }
    return values;
  }
  if (handle === 'rot_x' || handle === 'rot_y' || handle === 'rot_z') {
    if (st.device === 'camera') {
      if (handle === 'rot_x') values.orientationX = st.orientation.x + move.rot.x;
      if (handle === 'rot_y') values.orientationY = st.orientation.y + move.rot.y;
      if (handle === 'rot_z') values.orientationZ = st.orientation.z + move.rot.z;
    } else if (handle === 'rot_z' && lightHasDirection(st)) {
      values.lightAngle = st.lightAngle + move.rot.z;
    }
  }
  return values;
}
