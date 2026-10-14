/**
 * Camera ▸ Fly to Selected Layers (camera program R4, 2026-10-14) — the shot
 * sequencer: from the playhead, the camera travels to frame each selected
 * layer in turn (selection order), holds on it, and moves on.
 *
 *   playhead ─travel─▶ layer 1 ─hold─ ─travel─▶ layer 2 ─hold─ …
 *
 * For each layer the framing is `framingFor` (the Look at Selected Layers
 * fit: the layer's box enclosed with a little air), re-scaled from the default
 * lens it assumes to THIS camera's Zoom, along the direction the camera
 * already looks — so the move is a dolly-and-truck, never a spin, and a
 * layer facing the camera ends up square in the frame.
 *
 *   • Two-node camera — Position and Point of Interest are keyed: the POI
 *     lands on the layer, the eye the framing distance back from it.
 *   • One-node camera — Position only: it keeps its rotation (its view
 *     direction), which is what centres the layer.
 *
 * Either way the camera's orbit angles are respected: the stored Position is
 * solved back through `orbitCamera` (the eye the renderer resolves is the
 * stored one swung about the POI, or the comp centre, by Orbit Yaw / Pitch),
 * and a parented camera's targets are taken into its parent's space.
 *
 * Keys: one at the playhead (the shot as it is), then an arrival and a
 * hold-end key per layer. Every travel is eased SMOOTH (the camera presets'
 * curve), spatially LINEAR (two equal keys with auto-Bézier tangents would
 * drift during the hold). ONE `addKeyframes`: one undo entry.
 */

import type { Command, KeyframeInsert, Value } from '@motion/engine-api';
import { Matrix4Math, Project3D, type Matrix4, type Vec3 } from '@motion/scene';
import { activeCompSize } from '@core/scene/activeComp';
import { engine } from '@core/engine/engineInstance';
import { compTime, propRefForTrack } from '@core/engine/propRefs';
import { edit } from '@core/engine/uiEdits';
import { documentMirror } from '@stores/documentMirror';
import { framingFor, framingSubjects, resolveCommandCamera } from './cameraCommands';

/** The camera presets' SMOOTH curve: an operated move, not a scrub. */
export const SMOOTH_EASE = { x1: 0.4, y1: 0, x2: 0.2, y2: 1 } as const;

export interface FlyToOptions {
  /** Seconds from one framing to the next. */
  travel: number;
  /** Seconds the camera rests on each layer. */
  hold: number;
}

export const FLY_TO_DEFAULTS: FlyToOptions = { travel: 1, hold: 1 };

/** When the camera arrives at (and leaves) layer `i` (0-based), from `start`. Pure. */
export function flyToTimes(start: number, i: number, { travel, hold }: FlyToOptions): { arrive: number; leave: number } {
  const arrive = start + i * (travel + hold) + travel;
  return { arrive, leave: arrive + hold };
}

/**
 * The stored base that resolves to `eye` once swung about `centre` by
 * (`yaw`, `pitch`) — `orbitCamera` is a rotation about the centre, so its
 * inverse is the transpose, read off the images of the basis vectors.
 */
export function unorbit(eye: Vec3, centre: Vec3, yaw: number, pitch: number): Vec3 {
  if (yaw === 0 && pitch === 0) return eye;
  const col = (v: Vec3): Vec3 => {
    const p = Project3D.orbitCamera({ x: centre.x + v.x, y: centre.y + v.y, z: centre.z + v.z }, centre, yaw, pitch).position;
    return { x: p.x - centre.x, y: p.y - centre.y, z: p.z - centre.z };
  };
  const cx = col({ x: 1, y: 0, z: 0 });
  const cy = col({ x: 0, y: 1, z: 0 });
  const cz = col({ x: 0, y: 0, z: 1 });
  const d = { x: eye.x - centre.x, y: eye.y - centre.y, z: eye.z - centre.z };
  return {
    x: centre.x + cx.x * d.x + cx.y * d.y + cx.z * d.z,
    y: centre.y + cy.x * d.x + cy.y * d.y + cy.z * d.z,
    z: centre.z + cz.x * d.x + cz.y * d.y + cz.z * d.z,
  };
}

async function worldMatrix(layer: string, seconds: number): Promise<Matrix4 | null> {
  const res = await engine().query({ type: 'getLayerTransforms', layers: [layer], time: compTime(seconds) });
  const m = res.ok ? res.value.transforms.find((t) => t.layer === layer)?.matrix : undefined;
  return m && m.length === 16 ? (m as unknown as Matrix4) : null;
}

/** One property a point is keyed on, and how a point becomes its value. */
interface VectorTarget {
  prop: { layer: string; path: string };
  value: (p: Vec3) => Value;
}

/**
 * The properties holding a point's three tracks: ONE vec3 (Position), or a
 * scalar per axis (the Point of Interest keys each axis on its own track, as
 * its Inspector row shows it). Empty when a track is missing.
 */
function vectorTargets(camId: string, tracks: readonly [string, string, string]): VectorTarget[] {
  const refs = tracks.map((t) => propRefForTrack(camId, t));
  if (refs.some((r) => !r)) return [];
  const first = refs[0]!;
  if (refs.every((r) => r!.ref.path === first.ref.path)) {
    if (first.valueType !== 'vec3') return [];
    return [{ prop: first.ref, value: (p) => ({ kind: 'vec3', value: { x: p.x, y: p.y, z: p.z } }) }];
  }
  const axis: Array<keyof Vec3> = ['x', 'y', 'z'];
  return refs.map((r, i) => ({ prop: r!.ref, value: (p: Vec3): Value => ({ kind: 'scalar', value: p[axis[i]!] }) }));
}

export type FlyToResult = { ok: true; keys: number; end: number } | { ok: false; reason: string };
export type FlyToPlan = { ok: true; keys: number; end: number; command: Command } | { ok: false; reason: string };

/**
 * Fly to Selected Layers as ONE undo entry: keys on `camId` from `start`
 * framing each of `layers` in order. Resolves to how many keys were laid and
 * when the last hold ends.
 */
export async function flyToLayersEdit(camId: string, layers: readonly string[], start: number, opts: FlyToOptions = FLY_TO_DEFAULTS): Promise<FlyToResult> {
  const plan = await planFlyTo(camId, layers, start, opts);
  if (!plan.ok) return plan;
  const res = await edit('Fly to Selected Layers', plan.command);
  return res.ok ? { ok: true, keys: plan.keys, end: plan.end } : { ok: false, reason: res.error.message };
}

/** The Fly to write, composed but not sent (the AI sends it through its turn). */
export async function planFlyTo(camId: string, layers: readonly string[], start: number, opts: FlyToOptions = FLY_TO_DEFAULTS): Promise<FlyToPlan> {
  if (layers.length === 0) return { ok: false, reason: 'Select the layers to fly to' };
  if (!(opts.travel > 0) || !(opts.hold >= 0)) return { ok: false, reason: 'Travel must be longer than zero' };
  const m = documentMirror();
  await m.loadTree(camId);
  const rig = await resolveCommandCamera(camId, start);
  if (!rig) return { ok: false, reason: 'Select a camera' };
  const twoNode = rig.poi !== null;
  const pos = vectorTargets(camId, ['x', 'y', 'z']);
  const poi = twoNode ? vectorTargets(camId, ['poiX', 'poiY', 'poiZ']) : [];
  if (pos.length === 0 || (twoNode && poi.length === 0)) return { ok: false, reason: 'The camera cannot be keyed' };

  const { width, height } = activeCompSize();
  const camera = rig.camera;
  // The direction the camera looks now (through the principal point): kept for every framing.
  const ray = Project3D.unprojectScreenRay(camera.principal.x, camera.principal.y, camera, null, width, height);
  const fwd = ray.direction;
  const lensScale = camera.focalLength / Project3D.defaultCamera(width, height).focalLength;
  const parent = m.layer(camId)?.parent;
  const parentWorld = parent ? await worldMatrix(parent, start) : null;
  const toParent = (p: Vec3): Vec3 => (parentWorld ? Matrix4Math.toLocalPoint(parentWorld, p) : p);
  const yaw = rig.values.orbitYaw ?? 0;
  const pitch = rig.values.orbitPitch ?? 0;

  const keys: KeyframeInsert[] = [];
  /** Keys for a point on `targets` at `t` (absent: the property's current value there). */
  const keyAt = (targets: readonly VectorTarget[], t: number, p: Vec3 | undefined, ease: boolean): void => {
    for (const target of targets) {
      keys.push({
        prop: target.prop,
        time: compTime(t),
        ...(p ? { value: target.value(p) } : {}),
        ...(ease ? { easing: 'bezier' as const, bezier: { ...SMOOTH_EASE } } : { easing: 'linear' as const }),
        spatialInterp: 'linear',
        spatialIn: [],
        spatialOut: [],
      });
    }
  };
  // The shot as it is, where the move starts.
  keyAt(pos, start, undefined, true);
  keyAt(poi, start, undefined, true);

  let end = start;
  for (const [i, id] of layers.entries()) {
    const { arrive, leave } = flyToTimes(start, i, opts);
    const [subject] = await framingSubjects([id], arrive);
    if (!subject) return { ok: false, reason: `${m.layer(id)?.name ?? 'A layer'} cannot be framed` };
    const framing = framingFor([subject], width, height);
    if (!framing) return { ok: false, reason: 'Nothing to frame' };
    const d = framing.distance * lensScale;
    const target = framing.poi;
    const eyeWorld = { x: target.x - fwd.x * d, y: target.y - fwd.y * d, z: target.z - fwd.z * d };
    const eye = toParent(eyeWorld);
    const centre = twoNode ? toParent(target) : { x: width / 2, y: height / 2, z: 0 };
    const base = unorbit(eye, centre, yaw, pitch);
    keyAt(pos, arrive, base, false);
    keyAt(pos, leave, base, true);
    keyAt(poi, arrive, twoNode ? centre : undefined, false);
    keyAt(poi, leave, twoNode ? centre : undefined, true);
    end = leave;
  }
  // A zero hold would put two keys at one time: the arrival is enough.
  const unique = keys.filter((k, i) => keys.findIndex((o) => o.prop.path === k.prop.path && o.time === k.time) === i);
  return { ok: true, keys: unique.length, end, command: { type: 'addKeyframes', keys: unique } };
}
