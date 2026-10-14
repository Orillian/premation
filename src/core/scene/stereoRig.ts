/**
 * Create Stereo 3D Rig (camera program D7) — After Effects' Layer ▸ Camera ▸
 * Create Stereo 3D Rig, as ONE history entry (an engine gesture):
 *
 *   scene comp   + "Stereo Camera Controls" null (Interaxial Separation,
 *                  Convergence Of, Convergence Z Offset, Stereo Scene Depth)
 *                + "Left Camera" / "Right Camera": two-node cameras placed
 *                  BELOW the master (the master stays the comp's active
 *                  camera), whose position, Point of Interest, Zoom and depth
 *                  of field follow the master by expression
 *   Left Eye     the scene comp as a layer that looks through Left Camera
 *   Right Eye    … through Right Camera (`layer/viewCamera`, the engine's
 *                composition-layer camera override)
 *   Stereo 3D    Left Eye with 3D Glasses (Right View = Right Eye, hidden
 *                below it): anaglyph by default; the effect's 3D View picks
 *                side-by-side, over-under or interlaced
 *
 * The eyes sit on the master's horizontal right axis, ± half the interaxial
 * (Interaxial Separation px, or — when that is 0 — Stereo Scene Depth % of the
 * comp width, AE's default). Convergence Of: 0 Off (parallel eyes), 1 the
 * master's Point of Interest (a one-node master: its focus distance ahead),
 * 2 the plane z = 0; Convergence Z Offset moves the convergence point along
 * the view. Everything is live: keyframe the master and the eyes follow.
 *
 * The master is read in its own layer space, so the rig assumes an unparented
 * master camera (the usual case; AE's rig has the same reach).
 */

import type { Command as EngineCommand, Value } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { plainValue } from '@core/mirror/trackIndex';

export const STEREO_CONTROL_NAMES = {
  interaxial: 'Interaxial Separation',
  convergence: 'Convergence Of',
  zOffset: 'Convergence Z Offset',
  sceneDepth: 'Stereo Scene Depth',
} as const;

export type StereoControlNames = { -readonly [K in keyof typeof STEREO_CONTROL_NAMES]: string };

/** What the rig is built from: the master camera, its comp, and whether it aims at a Point of Interest. */
export interface StereoRigSource {
  camera: string;
  comp: string;
  twoNode: boolean;
}

const q = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// The expression language is ONE expression (motion_expr's Pratt parser: no
// `var`, no statements, no `if`), so the shared parts below are inlined
// fragments and the convergence modes are a `?:` chain.

/** The master camera layer, its position, and its forward unit vector. */
function masterParts(master: string, twoNode: boolean): { m: string; p: string; f: string } {
  const m = `thisComp.layer(${q(`#${master}`)})`;
  const p = `${m}.position`;
  if (twoNode) return { m, p, f: `normalize(sub(${m}.pointOfInterest, ${p}))` };
  // A one-node camera looks along its X / Y Rotation (transform.cpp look_at_orientation, inverted).
  const ry = `(thisComp.layer(${q(`#${master}`)}, 'orientationY') * Math.PI / 180)`;
  const rx = `(thisComp.layer(${q(`#${master}`)}, 'orientationX') * Math.PI / 180)`;
  return { m, p, f: `[Math.sin(${ry}) * Math.cos(${rx}), -Math.sin(${rx}), Math.cos(${ry}) * Math.cos(${rx})]` };
}

/** The eye's position: the master's, moved half the interaxial along its right axis. */
function eyeOf(p: string, f: string, side: -1 | 1, names: StereoControlNames): string {
  const right = `normalize([(${f})[2], 0, -(${f})[0]])`;
  const ia =
    `(ctrl(${q(names.interaxial)}) > 0 ? ctrl(${q(names.interaxial)}) : ctrl(${q(names.sceneDepth)}) / 100 * thisComp.width)`;
  return `add(${p}, mul(${right}, ${side} * ${ia} / 2))`;
}

/** The eye camera's Position expression (a vector: each axis takes its component). */
export function eyePositionExpression(master: string, twoNode: boolean, side: -1 | 1, names: StereoControlNames): string {
  const { p, f } = masterParts(master, twoNode);
  return eyeOf(p, f, side, names);
}

/** The eye camera's Point of Interest expression: where the eyes converge. */
export function eyePoiExpression(master: string, twoNode: boolean, side: -1 | 1, names: StereoControlNames): string {
  const { m, p, f } = masterParts(master, twoNode);
  const fd = `${m}.cameraOption.focusDistance`;
  const mode = `Math.round(ctrl(${q(names.convergence)}))`;
  const ahead = `add(${p}, mul(${f}, ${fd}))`;
  // 1: the master's Point of Interest (a one-node master: its focus distance ahead);
  // 2: the plane z = 0 along the view; 0 (Off): parallel eyes.
  const onPoi = twoNode ? `${m}.pointOfInterest` : ahead;
  const onZero = `(Math.abs((${f})[2]) > 1e-6 ? add(${p}, mul(${f}, -(${p})[2] / (${f})[2])) : ${ahead})`;
  const parallel = `add(${eyeOf(p, f, side, names)}, mul(${f}, ${fd}))`;
  const c = `(${mode} == 2 ? ${onZero} : ${mode} == 0 ? ${parallel} : ${onPoi})`;
  return `add(${c}, mul(${f}, ctrl(${q(names.zOffset)})))`;
}

/** Zoom / focus / depth of field follow the master. */
export function eyeOptionExpression(master: string, option: 'zoom' | 'focusDistance' | 'blurLevel' | 'aperture'): string {
  return `thisComp.layer(${q(`#${master}`)}).cameraOption.${option}`;
}

const scalar = (value: number): Value => ({ kind: 'scalar', value });

/** The rig's source when `camera` is a camera layer, else null. */
export function stereoRigSource(camera: string): StereoRigSource | null {
  const m = documentMirror();
  const layer = m.layer(camera);
  if (!layer || layer.kind !== 'camera') return null;
  const comp = layer.comp;
  if (!comp) return null;
  const twoNode = plainValue(m.property(camera, 'transform/orientTowardsPointOfInterest')?.value) === true;
  return { camera, comp, twoNode };
}

export interface StereoRig {
  controls: string;
  left: string;
  right: string;
  leftComp: string;
  rightComp: string;
  outputComp: string;
  names: StereoControlNames;
}

/**
 * Build the rig as one undo entry. Resolves to what was made, or null when
 * the engine refused a step (the gesture is rolled back).
 */
export async function createStereoRigEdit(src: StereoRigSource): Promise<StereoRig | null> {
  const e = engine();
  const settings = documentMirror().comp(src.comp)?.settings;
  if (!settings) return null;
  const camName = documentMirror().layer(src.camera)?.name ?? 'Camera';
  const began = await e.execute({ type: 'beginGesture', label: 'Create Stereo 3D Rig' });
  if (!began.ok) return null;
  let ok = false;
  let rig: StereoRig | null = null;
  const run = async <T>(cmd: EngineCommand): Promise<T | null> => {
    const r = await e.execute(cmd);
    return r.ok ? (r.value as T) : null;
  };
  try {
    // The controls null and its four expression controls (names are global: a
    // second rig suffixes them with its camera's name).
    const ctl = await run<{ layer: string }>({ type: 'createLayer', comp: src.comp, kind: 'null', name: 'Stereo Camera Controls', init: [] });
    if (!ctl) return null;
    const names = { ...STEREO_CONTROL_NAMES } as StereoControlNames;
    const defaults: Record<keyof StereoControlNames, { match: string; param: string; value: number }> = {
      interaxial: { match: 'ADBE Slider Control', param: 'slider', value: 0 },
      convergence: { match: 'ADBE Dropdown Control', param: 'menu', value: 1 },
      zOffset: { match: 'ADBE Slider Control', param: 'slider', value: 0 },
      sceneDepth: { match: 'ADBE Slider Control', param: 'slider', value: 3 },
    };
    for (const key of Object.keys(defaults) as Array<keyof StereoControlNames>) {
      const d = defaults[key];
      const add = (name: string): Promise<{ groups: string[] } | null> =>
        run<{ groups: string[] }>({ type: 'addPropertyGroup', layer: ctl.layer, parent: 'effects', matchName: d.match, name, init: [{ path: d.param, value: scalar(d.value) }] });
      let made = await add(names[key]);
      if (!made) {
        names[key] = `${names[key]} (${camName})`;
        made = await add(names[key]);
      }
      if (!made) return null;
    }

    // The eyes: two-node cameras under the master, following it by expression.
    const eyes: string[] = [];
    for (const [side, name] of [[-1, 'Left Camera'], [1, 'Right Camera']] as const) {
      const eye = await run<{ layer: string }>({ type: 'createLayer', comp: src.comp, kind: 'camera', name, init: [] });
      if (!eye) return null;
      eyes.push(eye.layer);
      if (!(await run({ type: 'setProperty', prop: { layer: eye.layer, path: 'transform/orientTowardsPointOfInterest' }, value: { kind: 'bool', value: true } }))) return null;
      const pos = eyePositionExpression(src.camera, src.twoNode, side, names);
      const poi = eyePoiExpression(src.camera, src.twoNode, side, names);
      const exprs: Array<[string, string]> = [
        ['transform/position', pos],
        ['camera/poiX', poi],
        ['camera/poiY', poi],
        ['camera/poiZ', poi],
        ['camera/focalLength', eyeOptionExpression(src.camera, 'zoom')],
        ['camera/focusDistance', eyeOptionExpression(src.camera, 'focusDistance')],
        ['camera/dofStrength', eyeOptionExpression(src.camera, 'blurLevel')],
        ['camera/dofAperture', eyeOptionExpression(src.camera, 'aperture')],
      ];
      for (const [path, source] of exprs) {
        if (!(await run({ type: 'setExpression', prop: { layer: eye.layer, path }, source, enabled: true }))) return null;
      }
    }
    // Below the master, so the master stays the comp's active camera.
    const stack = documentMirror().comp(src.comp)?.layers ?? [];
    const masterIndex = stack.indexOf(src.camera);
    if (masterIndex >= 0) {
      if (!(await run({ type: 'reorderLayers', comp: src.comp, layers: eyes, toIndex: masterIndex + 1 }))) return null;
    }

    // Left Eye / Right Eye: the scene seen through each eye.
    const compSettings = {
      width: settings.width, height: settings.height, frameRate: settings.frameRate, duration: settings.duration,
      pixelAspect: settings.pixelAspect, background: settings.background,
    };
    const eyeComps: string[] = [];
    const eyeLayers: string[] = [];
    for (const [i, name] of (['Left Eye', 'Right Eye'] as const).entries()) {
      const comp = await run<{ item: string }>({ type: 'createComposition', settings: { ...compSettings, name: `${settings.name} ${name}` }, fromItems: [] });
      if (!comp) return null;
      eyeComps.push(comp.item);
      const scene = await run<{ layer: string }>({ type: 'createLayer', comp: comp.item, kind: 'precomp', source: src.comp, init: [] });
      if (!scene) return null;
      if (!(await run({ type: 'setProperty', prop: { layer: scene.layer, path: 'layer/viewCamera' }, value: { kind: 'string', value: eyes[i]! } }))) return null;
    }

    // The output: Left Eye over a hidden Right Eye, combined by 3D Glasses.
    const out = await run<{ item: string }>({ type: 'createComposition', settings: { ...compSettings, name: `${settings.name} Stereo 3D` }, fromItems: [] });
    if (!out) return null;
    for (const comp of [...eyeComps].reverse()) {
      const l = await run<{ layer: string }>({ type: 'createLayer', comp: out.item, kind: 'precomp', source: comp, index: 0, init: [] });
      if (!l) return null;
      eyeLayers.unshift(l.layer);
    }
    const [leftLayer, rightLayer] = eyeLayers as [string, string];
    if (!(await run({ type: 'setLayerSwitches', layers: [rightLayer], patch: { visible: false } }))) return null;
    if (!(await run({
      type: 'addEffect', layers: [leftLayer], effect: '3d-glasses',
      params: [
        { path: 'rightView', value: { kind: 'layer', value: rightLayer } },
        { path: 'convergenceOffset', value: scalar(0) },
      ],
    }))) return null;

    rig = { controls: ctl.layer, left: eyes[0]!, right: eyes[1]!, leftComp: eyeComps[0]!, rightComp: eyeComps[1]!, outputComp: out.item, names };
    ok = true;
  } finally {
    await e.execute({ type: 'endGesture', gesture: began.value.gesture, commit: ok });
  }
  return ok ? rig : null;
}
