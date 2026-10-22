/**
 * Camera rigs — Layer ▸ Camera ▸ Add Camera Rig ▸ Crane / Dolly / Orbit
 * (camera program R2, 2026-10-14).
 *
 * What After Effects users build by hand (or buy a script for): a chain of 3D
 * nulls above the camera, each null one thing a camera operator does — so a
 * crane move is keyframing ONE number on the boom instead of solving an arc
 * into Position keys. Here a rig is a chain of parented 3D nulls named
 * `Rig · <Kind> · <Control>`, the camera parented under the last one:
 *
 *   Crane   Base (truck X / dolly Z / pedestal Y)
 *             → Boom (height · swing = Y rotation)
 *               → Arm (its length: the camera sits at the arm's end)
 *   Dolly   Track (truck X / dolly Z) → Pedestal (height)
 *   Orbit   Pivot (at the camera's target: moves it, swings / booms the eye
 *                  around it) → Arm (the eye's distance from the target)
 *
 * Pan and Tilt (every kind) turn the camera itself on the spot.
 *
 * The names ARE the rig: `rigOf` reads a rig back from any of its members by
 * the name chain, so a rig survives save / load / copy with nothing stored
 * beyond ordinary layers, and a user who renames a null has simply taken it
 * out of the rig's sliders (it keeps working as a null).
 *
 * ## Nothing moves when the rig is added
 *
 * The nulls are placed so their chain composes to a pure translation that
 * lands on the camera's eye (the crane's base a boom-length behind it, the
 * orbit pivot on its target), and the camera is re-based into the last null
 * rigidly — base values and every key by the same delta, eye and Point of
 * Interest alike (`rebaseUnder`, the Create Orbit Null re-base). ONE engine
 * gesture: one undo entry, and Undo removes every null.
 *
 * ## The sliders
 *
 * `RIG_CONTROLS` maps a control (Truck, Pedestal, Dolly, Boom, Swing, Arm,
 * Pan, Tilt) to the null and track it writes; the Camera Rig Inspector section
 * draws them as ordinary keyframable rows on those nulls. `Arm` is a length,
 * not a track — the arm null's position vector scaled — so an orbit rig's arm
 * follows the eye's real direction from the target, not an axis.
 */

import type { Command as EngineCommand, CommandResult, LayerInfo } from '@motion/engine-api';
import type { Vec3 } from '@motion/scene';
import { activeCompSize } from '@core/scene/activeComp';
import { engine } from '@core/engine/engineInstance';
import { compOfLayer } from '@core/mirror/docFacts';
import { uiKindOf } from '@core/mirror/layerKinds';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import {
  orbitPivotFor,
  rebaseCommands,
  rebaseUnder,
  resolveCommandCamera,
  storedCameraPoints,
} from './cameraCommands';
import { t } from '@core/i18n';

export type CameraRigKind = 'crane' | 'dolly' | 'orbit';

export const CAMERA_RIG_KINDS: ReadonlyArray<{ kind: CameraRigKind; label: string; description: string }> = [
  { kind: 'crane', get label() { return t('core.cameraRig.crane', 'Crane'); }, get description() { return t('core.cameraRig.descriptionBaseBoomArmBoomUp', 'Base → Boom → Arm: boom up and swing the camera through an arc'); } },
  { kind: 'dolly', get label() { return t('core.cameraRig.dolly', 'Dolly'); }, get description() { return t('core.cameraRig.descriptionTrackPedestalTruckAndDolly', 'Track → Pedestal: truck and dolly on the floor, rise on the pedestal'); } },
  { kind: 'orbit', get label() { return t('core.cameraRig.orbit', 'Orbit'); }, get description() { return t('core.cameraRig.descriptionPivotArmSwingAndTilt', 'Pivot → Arm: swing and tilt the camera around its target'); } },
];

/** The nulls of each rig, top of the chain first (the camera hangs under the last). */
export const RIG_NULLS: Readonly<Record<CameraRigKind, readonly string[]>> = {
  crane: ['Base', 'Boom', 'Arm'],
  dolly: ['Track', 'Pedestal'],
  orbit: ['Pivot', 'Arm'],
};

const KIND_LABEL: Readonly<Record<CameraRigKind, string>> = { crane: 'Crane', dolly: 'Dolly', orbit: 'Orbit' };

/** `Rig · Crane · Boom`. */
export function rigNullName(kind: CameraRigKind, control: string): string {
  return `Rig · ${KIND_LABEL[kind]} · ${control}`;
}

const NAME_RE = /^Rig · (Crane|Dolly|Orbit) · (\w+)$/;

/** The rig kind and control a layer name names (null: not a rig null). */
export function parseRigNullName(name: string | undefined): { kind: CameraRigKind; control: string } | null {
  const m = name ? NAME_RE.exec(name) : null;
  if (!m) return null;
  return { kind: m[1]!.toLowerCase() as CameraRigKind, control: m[2]! };
}

export type RigControl = 'Truck' | 'Pedestal' | 'Dolly' | 'Boom' | 'Swing' | 'Arm' | 'Pan' | 'Tilt';

/** Every control, in the order the Inspector lists them. */
export const RIG_CONTROL_ORDER: readonly RigControl[] = ['Truck', 'Pedestal', 'Dolly', 'Boom', 'Swing', 'Arm', 'Pan', 'Tilt'];

/** Display name of a control (the `RigControl` value itself is an id and a null name). */
export function rigControlLabel(control: RigControl): string {
  switch (control) {
    case 'Truck': return t('core.cameraRig.controlTruck', 'Truck');
    case 'Pedestal': return t('core.cameraRig.controlPedestal', 'Pedestal');
    case 'Dolly': return t('core.cameraRig.controlDolly', 'Dolly');
    case 'Boom': return t('core.cameraRig.controlBoom', 'Boom');
    case 'Swing': return t('core.cameraRig.controlSwing', 'Swing');
    case 'Arm': return t('core.cameraRig.controlArm', 'Arm');
    case 'Pan': return t('core.cameraRig.controlPan', 'Pan');
    case 'Tilt': return t('core.cameraRig.controlTilt', 'Tilt');
    default: return control;
  }
}

/**
 * What a control writes: a null of the rig (by its control name) — or the
 * rigged `camera` itself — and a track, or `arm`: the null's position length.
 */
export interface RigControlTarget {
  null: string;
  track: 'x' | 'y' | 'z' | 'rotationX' | 'rotationY' | 'orientationX' | 'orientationY' | 'arm';
  unit: 'px' | '°';
  /** The tooltip: what the control does to the shot. */
  hint: string;
}

/**
 * Pan and tilt are the CAMERA's own "Turn on the spot" (orientation Y / X),
 * not a null's rotation: a camera resolves its parents by lifting its eye and
 * Point of Interest through them (camera3d `cameraFromValues`), so a rotating
 * null turns a two-node camera's aim but not a one-node camera's — the
 * camera's own orientation turns both.
 */
const PAN: RigControlTarget = { null: 'camera', track: 'orientationY', unit: '°', get hint() { return t('core.cameraRig.hintPanTheCameraHeadLeft', 'Pan the camera head left or right (Turn on the spot)'); } };
const TILT: RigControlTarget = { null: 'camera', track: 'orientationX', unit: '°', get hint() { return t('core.cameraRig.hintTiltTheCameraHeadUp', 'Tilt the camera head up or down (Turn on the spot)'); } };

export const RIG_CONTROLS: Readonly<Record<CameraRigKind, Partial<Record<RigControl, RigControlTarget>>>> = {
  crane: {
    Truck: { null: 'Base', track: 'x', unit: 'px', get hint() { return t('core.cameraRig.hintSlideTheWholeCraneSideways', 'Slide the whole crane sideways'); } },
    Pedestal: { null: 'Base', track: 'y', unit: 'px', get hint() { return t('core.cameraRig.hintRaiseOrLowerTheWhole', 'Raise or lower the whole crane'); } },
    Dolly: { null: 'Base', track: 'z', unit: 'px', get hint() { return t('core.cameraRig.hintRollTheWholeCraneTowards', 'Roll the whole crane towards or away from the scene'); } },
    Boom: { null: 'Boom', track: 'y', unit: 'px', get hint() { return t('core.cameraRig.hintBoomHeightLiftTheArm', 'Boom height: lift the arm (and the camera) up or down'); } },
    Swing: { null: 'Boom', track: 'rotationY', unit: '°', get hint() { return t('core.cameraRig.hintSwingTheArmAroundThe', 'Swing the arm around the base — the camera travels an arc'); } },
    Arm: { null: 'Arm', track: 'arm', unit: 'px', get hint() { return t('core.cameraRig.hintArmLengthHowFarThe', 'Arm length: how far the camera reaches out from the base'); } },
    Pan: PAN,
    Tilt: TILT,
  },
  dolly: {
    Truck: { null: 'Track', track: 'x', unit: 'px', get hint() { return t('core.cameraRig.hintTruckSlideTheDollySideways', 'Truck: slide the dolly sideways along the track'); } },
    Dolly: { null: 'Track', track: 'z', unit: 'px', get hint() { return t('core.cameraRig.hintDollyRollTowardsOrAway', 'Dolly: roll towards or away from the scene'); } },
    Pedestal: { null: 'Pedestal', track: 'y', unit: 'px', get hint() { return t('core.cameraRig.hintPedestalRaiseOrLowerThe', 'Pedestal: raise or lower the camera on its column'); } },
    Pan: PAN,
    Tilt: TILT,
  },
  orbit: {
    Truck: { null: 'Pivot', track: 'x', unit: 'px', get hint() { return t('core.cameraRig.hintMoveTheTargetSidewaysThe', 'Move the target sideways (the camera follows)'); } },
    Pedestal: { null: 'Pivot', track: 'y', unit: 'px', get hint() { return t('core.cameraRig.hintMoveTheTargetUpOr', 'Move the target up or down (the camera follows)'); } },
    Dolly: { null: 'Pivot', track: 'z', unit: 'px', get hint() { return t('core.cameraRig.hintMoveTheTargetInDepth', 'Move the target in depth (the camera follows)'); } },
    Swing: { null: 'Pivot', track: 'rotationY', unit: '°', get hint() { return t('core.cameraRig.hintSwingTheCameraAroundIts', 'Swing the camera around its target'); } },
    Boom: { null: 'Pivot', track: 'rotationX', unit: '°', get hint() { return t('core.cameraRig.hintBoomTheCameraUpOver', 'Boom the camera up over (or down under) its target'); } },
    Pan: PAN,
    Arm: { null: 'Arm', track: 'arm', unit: 'px', get hint() { return t('core.cameraRig.hintDistanceFromTheCameraTo', 'Distance from the camera to its target'); } },
  },
};

/** A rig as read from the document. */
export interface RigInfo {
  kind: CameraRigKind;
  /** Null ids by control name (`Base`, `Boom`, …). */
  nulls: Readonly<Record<string, string>>;
  /** The camera hanging under the last null (null: none — the rig drives nothing). */
  camera: string | null;
}

interface MirrorRigRead {
  layer(id: string): LayerInfo | undefined;
  layerIds(): Iterable<string>;
}

/**
 * The layers PARENTED to `id` (AE's parent link). Not `LayerInfo.children`,
 * which lists a group's nested layers — parenting is only recorded on the
 * child, so finding a parent's children is a scan of the layers.
 */
function parentedTo(m: MirrorRigRead, id: string): string[] {
  const out: string[] = [];
  for (const l of m.layerIds()) if (m.layer(l)?.parent === id) out.push(l);
  return out;
}

function rigNullOf(m: MirrorRigRead, id: string | undefined, kind?: CameraRigKind): { kind: CameraRigKind; control: string } | null {
  const l = id ? m.layer(id) : undefined;
  if (!l || uiKindOf(l) !== 'null') return null;
  const p = parseRigNullName(l.name);
  return p && (!kind || p.kind === kind) ? p : null;
}

/**
 * The rig `id` belongs to — `id` being the rigged camera or any of the rig's
 * nulls — or null. A chain counts only when it is complete and in order
 * (`RIG_NULLS`), so a half-deleted rig stops offering sliders that would
 * write a null that is not there.
 */
export function rigOf(id: string, m: MirrorRigRead = documentMirror()): RigInfo | null {
  const layer = m.layer(id);
  if (!layer) return null;
  let bottom: string;
  let camera: string | null = null;
  if (uiKindOf(layer) === 'camera') {
    if (!layer.parent || !rigNullOf(m, layer.parent)) return null;
    bottom = layer.parent;
    camera = id;
  } else {
    const own = rigNullOf(m, id);
    if (!own) return null;
    bottom = id;
    // Down the chain to its last null, then the camera under it.
    for (let guard = 0; guard < 8; guard++) {
      const next: string | undefined = parentedTo(m, bottom).find((c) => rigNullOf(m, c, own.kind));
      if (!next) break;
      bottom = next;
    }
    camera = parentedTo(m, bottom).find((c) => uiKindOf(m.layer(c)) === 'camera') ?? null;
  }
  const kind = rigNullOf(m, bottom)!.kind;
  const chain: Array<{ id: string; control: string }> = [];
  for (let cur: string | undefined = bottom, guard = 0; cur && guard < 8; guard++) {
    const p = rigNullOf(m, cur, kind);
    if (!p) break;
    chain.unshift({ id: cur, control: p.control });
    cur = m.layer(cur)?.parent;
  }
  const want = RIG_NULLS[kind];
  if (chain.length !== want.length || chain.some((c, i) => c.control !== want[i])) return null;
  return { kind, nulls: Object.fromEntries(chain.map((c) => [c.control, c.id])), camera };
}

// ── Building a rig ──────────────────────────────────────────────────────────

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

/**
 * Where each null of a rig goes: LOCAL positions, top first (the top's local
 * is its world). The chain composes to `eye` with no rotation, so the camera's
 * re-based eye is (0, 0, 0) under the last null.
 *
 *   Crane: the base a boom-length (`reach`) BEHIND the camera — the arm
 *          reaches forward from it along +Z, where the camera looks by default.
 *   Dolly: the track under the camera; the pedestal at it.
 *   Orbit: the pivot on the camera's target; the arm out to the eye.
 */
export function rigLayout(kind: CameraRigKind, eye: Vec3, pivot: Vec3, reach: number): Vec3[] {
  const zero = { x: 0, y: 0, z: 0 };
  switch (kind) {
    case 'crane':
      return [{ x: eye.x, y: eye.y, z: eye.z - reach }, zero, { x: 0, y: 0, z: reach }];
    case 'dolly':
      return [eye, zero];
    case 'orbit':
      return [pivot, sub(eye, pivot)];
  }
}

/**
 * Sends commands for a multi-step build and resolves to their results (null:
 * refused). The UI runs it inside an engine gesture (`addCameraRigEdit`); an
 * AI turn through its session (`ctx.engine.apply`), which is already one
 * undo entry.
 */
export type CommandExec = (commands: EngineCommand[]) => Promise<readonly CommandResult[] | null>;

/**
 * Build a rig on `camId` through `exec`: the nulls made and chained, the
 * camera parented under the last WITHOUT compensation and re-based into it so
 * nothing moves on screen. Resolves to the null ids (top first), or null.
 */
export async function buildCameraRig(camId: string, kind: CameraRigKind, time: number, exec: CommandExec): Promise<string[] | null> {
  const rig = await resolveCommandCamera(camId, time);
  const comp = compOfLayer(camId);
  if (!rig || !comp) return null;
  const { width, height } = activeCompSize();
  const points = storedCameraPoints(camId, rig, width, height);
  const eye = points.worldEye;
  const layout = rigLayout(kind, eye, orbitPivotFor(rig, width, height), Math.round(width * 0.25));
  const end = layout.reduce(add, { x: 0, y: 0, z: 0 });
  const rebase = rebaseCommands(camId, rebaseUnder(points, rig.lift, end));
  if (!rebase) return null;
  const ids: string[] = [];
  let parent: string | undefined;
  for (const [i, control] of RIG_NULLS[kind].entries()) {
    const at = layout[i]!;
    const made = await exec([{
      type: 'createLayer', comp, kind: 'null', name: rigNullName(kind, control),
      ...(parent ? { parent } : {}),
      init: [{ path: 'transform/position', value: { kind: 'vec2', value: { x: at.x, y: at.y } } }],
    }]);
    const id = (made?.[0] as { layer?: string } | undefined)?.layer;
    if (!id) return null;
    ids.push(id);
    const placed = await exec([
      { type: 'setLayerSwitches', layers: [id], patch: { threeD: true } },
      { type: 'setProperty', prop: { layer: id, path: 'transform/position' }, value: { kind: 'vec3', value: at } },
    ]);
    if (!placed) return null;
    parent = id;
  }
  const parented = await exec([{ type: 'setParent', layers: [camId], parent: parent!, keepWorldTransform: false }]);
  if (!parented) return null;
  if (rebase.length > 0 && !(await exec(rebase))) return null;
  return ids;
}

/**
 * Add Camera Rig as ONE history entry (an engine gesture) — `buildCameraRig`
 * with the camera selected after. Resolves to the null ids (top first), or
 * null when refused.
 */
export async function addCameraRigEdit(camId: string, kind: CameraRigKind, time: number): Promise<string[] | null> {
  const label = `Add Camera Rig (${KIND_LABEL[kind]})`;
  const e = engine();
  const began = await e.execute({ type: 'beginGesture', label });
  if (!began.ok) return null;
  let ids: string[] | null = null;
  try {
    ids = await buildCameraRig(camId, kind, time, async (cmds) => {
      const res = await e.batch(label, cmds);
      return res.ok ? res.value : null;
    });
  } finally {
    await e.execute({ type: 'endGesture', gesture: began.value.gesture, commit: ids !== null });
  }
  if (ids) useSelectionStore.getState().set([camId]);
  return ids;
}

/**
 * The commands that set a rig's Arm to `length`: the arm null's position
 * scaled along its own direction (keyed at `seconds` where animated or under
 * Auto-Keyframe — the caller passes `trackValueCommands`' options).
 */
export function armValues(current: Vec3, length: number): { x: number; y: number; z: number } {
  const len = Math.hypot(current.x, current.y, current.z);
  const L = Math.max(0, length);
  if (len < 1e-9) return { x: 0, y: 0, z: L };
  const k = L / len;
  return { x: current.x * k, y: current.y * k, z: current.z * k };
}

/** The selected camera's rig verbs' shared check: a camera to rig. */
export function canAddRig(camId: string | null): camId is string {
  return !!camId && uiKindOf(documentMirror().layer(camId)) === 'camera';
}

