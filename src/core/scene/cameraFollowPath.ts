/**
 * Camera ▸ Follow Path (camera program R3a, 2026-10-14) — After Effects'
 * "paste a path into Position", for a camera: a drawn path (a shape layer's
 * path, or a layer's first mask) becomes the camera's Position keyframes.
 *
 * What AE gives a user who copies a mask path and pastes it onto Position is
 * the exact curve: one key per vertex, the path's Bézier handles as the
 * keys' SPATIAL tangents, the first and last keys fixed and every key in
 * between ROVING so the move runs at a constant speed along the curve. That
 * is what this writes, as ONE `setKeyframes` (one undo entry):
 *
 *   • times — the first key at `start`, the last at `end`, the ones between
 *     placed by arc length (what roving would settle them to, so the move
 *     reads right even before the engine re-times anything);
 *   • space — each vertex through the path layer's world matrix at `start`,
 *     then into the camera's PARENT space (a rigged camera follows the path
 *     in world space, not in its rig's). A path on a 2D layer lies on the comp
 *     plane, so it sets the camera's X / Y and the camera keeps its own Z —
 *     a camera flown along z = 0 would sit IN the layers; a 3D layer's path
 *     is used in full;
 *   • a closed path ends where it began, the closing segment included.
 *
 * Inner shape-group transforms are not applied: the vertices are the path
 * property's own, in the layer's space (as Create Nulls From Path Points
 * reads them).
 */

import type { Command, Keyframe, Value } from '@motion/engine-api';
import { Matrix4Math, type Matrix4, type Vec3 } from '@motion/scene';
import { engine } from '@core/engine/engineInstance';
import { compTime, propRefForTrack } from '@core/engine/propRefs';
import { edit } from '@core/engine/uiEdits';
import { uiKindOf } from '@core/mirror/layerKinds';
import { readTrack } from '@core/mirror/selection';
import { documentMirror } from '@stores/documentMirror';

/** A path in one space: anchors and their tangents (relative to the anchor, AE's convention). */
export interface PathPoints {
  vertices: Vec3[];
  inTangents: Vec3[];
  outTangents: Vec3[];
  closed: boolean;
}

/** Where a layer's followable path lives: its shape path, else its first mask's path. Null: none. */
export async function followablePathOf(layerId: string): Promise<string | null> {
  const m = documentMirror();
  const layer = m.layer(layerId);
  if (!layer) return null;
  const tree = await m.loadTree(layerId);
  if (uiKindOf(layer) === 'shape' && tree?.nodes.get('layer/path.points')?.valueType === 'path') return 'layer/path.points';
  for (const [path, info] of tree?.nodes ?? []) {
    if (/^masks\/[^/]+\/path$/.test(path) && info.valueType === 'path') return path;
  }
  return null;
}

function pathValue(v: Value | undefined): PathPoints | null {
  if (v?.kind !== 'path') return null;
  const p = v.value;
  const pts = (flat: readonly number[]): Vec3[] => {
    const out: Vec3[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) out.push({ x: flat[i]!, y: flat[i + 1]!, z: 0 });
    return out;
  };
  const vertices = pts(p.vertices);
  if (vertices.length < 2) return null;
  const zero = (arr: Vec3[]): Vec3[] => vertices.map((_, i) => arr[i] ?? { x: 0, y: 0, z: 0 });
  return { vertices, inTangents: zero(pts(p.inTangents)), outTangents: zero(pts(p.outTangents)), closed: p.closed };
}

/** The matrix's linear part applied to a direction (tangents carry no translation). */
function linear(m: Matrix4, v: Vec3): Vec3 {
  return {
    x: m[0] * v.x + m[4] * v.y + m[8] * v.z,
    y: m[1] * v.x + m[5] * v.y + m[9] * v.z,
    z: m[2] * v.x + m[6] * v.y + m[10] * v.z,
  };
}

/** `path` with every anchor through `m` and every tangent through its linear part. */
export function transformPath(path: PathPoints, m: Matrix4): PathPoints {
  return {
    vertices: path.vertices.map((p) => Matrix4Math.transformPoint(m, p)),
    inTangents: path.inTangents.map((t) => linear(m, t)),
    outTangents: path.outTangents.map((t) => linear(m, t)),
    closed: path.closed,
  };
}

function bezierPoint(p0: Vec3, c0: Vec3, c1: Vec3, p1: Vec3, t: number): Vec3 {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c0.x + c * c1.x + d * p1.x,
    y: a * p0.y + b * c0.y + c * c1.y + d * p1.y,
    z: a * p0.z + b * c0.z + c * c1.z + d * p1.z,
  };
}

const plus = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

/** The arc length of each segment (i → i+1, the closing one last on a closed path), by sampling. */
export function segmentLengths(path: PathPoints, samples = 24): number[] {
  const n = path.vertices.length;
  const segs = path.closed ? n : n - 1;
  const out: number[] = [];
  for (let s = 0; s < segs; s++) {
    const i = s;
    const j = (s + 1) % n;
    const p0 = path.vertices[i]!;
    const p1 = path.vertices[j]!;
    const c0 = plus(p0, path.outTangents[i]!);
    const c1 = plus(p1, path.inTangents[j]!);
    let len = 0;
    let prev = p0;
    for (let k = 1; k <= samples; k++) {
      const q = bezierPoint(p0, c0, c1, p1, k / samples);
      len += Math.hypot(q.x - prev.x, q.y - prev.y, q.z - prev.z);
      prev = q;
    }
    out.push(len);
  }
  return out;
}

/**
 * The Position keys of a path, in the space `path` is already in: one per
 * vertex (a closed path's first vertex again at the end), times by arc length
 * from `start` to `end` (seconds), spatial tangents from the handles, the
 * keys between the ends roving. `keepZ` replaces every key's Z (a 2D path).
 * Pure.
 */
export function pathPositionKeys(path: PathPoints, start: number, end: number, keepZ: number | null): Keyframe[] {
  const order = path.closed ? [...path.vertices.keys(), 0] : [...path.vertices.keys()];
  const lengths = segmentLengths(path);
  const total = lengths.reduce((a, b) => a + b, 0);
  const span = Math.max(0, end - start);
  let run = 0;
  return order.map((vi, k): Keyframe => {
    if (k > 0) run += lengths[k - 1]!;
    const last = k === order.length - 1;
    const t = k === 0 ? start : last ? end : start + (total > 0 ? (span * run) / total : (span * k) / (order.length - 1));
    const p = path.vertices[vi]!;
    const z = keepZ ?? p.z;
    // The first key of a closed path has no incoming segment, the last no outgoing one.
    const tin = k === 0 ? { x: 0, y: 0, z: 0 } : path.inTangents[vi]!;
    const tout = last ? { x: 0, y: 0, z: 0 } : path.outTangents[vi]!;
    const flat = (v: Vec3): number[] => [v.x, v.y, keepZ === null ? v.z : 0];
    return {
      id: '',
      time: compTime(t),
      value: { kind: 'vec3', value: { x: p.x, y: p.y, z } },
      easing: 'linear',
      continuous: false,
      roving: k > 0 && !last,
      spatialInterp: 'bezier',
      spatialIn: flat(tin),
      spatialOut: flat(tout),
      label: 0,
      dims: [],
    };
  });
}

async function worldMatrix(layer: string, seconds: number): Promise<Matrix4 | null> {
  const res = await engine().query({ type: 'getLayerTransforms', layers: [layer], time: compTime(seconds) });
  const m = res.ok ? res.value.transforms.find((t) => t.layer === layer)?.matrix : undefined;
  return m && m.length === 16 ? (m as unknown as Matrix4) : null;
}

export type FollowPathResult =
  | { ok: true; keys: number }
  | { ok: false; reason: string };

export type FollowPathPlan =
  | { ok: true; keys: number; command: Command }
  | { ok: false; reason: string };

/**
 * Follow Path as ONE undo entry: `pathLayer`'s path (its shape path or first
 * mask) as `camId`'s Position keys from `start` to `end` (comp seconds).
 */
export async function followPathEdit(camId: string, pathLayer: string, start: number, end: number): Promise<FollowPathResult> {
  const plan = await planFollowPath(camId, pathLayer, start, end);
  if (!plan.ok) return plan;
  const res = await edit('Follow Path', plan.command);
  return res.ok ? { ok: true, keys: plan.keys } : { ok: false, reason: res.error.message };
}

/** The Follow Path write, composed but not sent (the AI sends it through its turn). */
export async function planFollowPath(camId: string, pathLayer: string, start: number, end: number): Promise<FollowPathPlan> {
  const m = documentMirror();
  if (uiKindOf(m.layer(camId)) !== 'camera') return { ok: false, reason: 'Select a camera' };
  if (!(end > start)) return { ok: false, reason: 'The move needs a duration' };
  const pathProp = await followablePathOf(pathLayer);
  if (!pathProp) return { ok: false, reason: `${m.layer(pathLayer)?.name ?? 'The layer'} has no path or mask to follow` };
  await m.loadTree(camId);
  const pos = propRefForTrack(camId, 'x');
  if (!pos || pos.valueType !== 'vec3' || pos.members.length < 3) return { ok: false, reason: 'Position is separated into X / Y / Z — join it to follow a path' };

  // The path at the move's start (an animated path's value then).
  const info = m.property(pathLayer, pathProp);
  const valueRes = info?.animated
    ? await engine().query({ type: 'getPropertyValues', props: [{ layer: pathLayer, path: pathProp }], time: compTime(start), evaluated: true })
    : null;
  const local = pathValue(valueRes?.ok ? valueRes.value.values[0]?.value : info?.value);
  if (!local) return { ok: false, reason: 'The path needs at least two points' };

  const [layerWorld, parentWorld] = await Promise.all([
    worldMatrix(pathLayer, start),
    m.layer(camId)?.parent ? worldMatrix(m.layer(camId)!.parent!, start) : Promise.resolve(null),
  ]);
  if (!layerWorld) return { ok: false, reason: 'Could not place the path' };
  let path = transformPath(local, layerWorld);
  if (parentWorld) {
    const inv = Matrix4Math.invert(parentWorld);
    if (inv) path = transformPath(path, inv);
  }
  const flat = m.layer(pathLayer)?.switches.threeD !== true;
  const keepZ = flat ? readTrack(m, camId, 'z', start) ?? null : null;
  const keys = pathPositionKeys(path, start, end, flat ? keepZ ?? 0 : null);
  return { ok: true, keys: keys.length, command: { type: 'setKeyframes', prop: pos.ref, keys } };
}
