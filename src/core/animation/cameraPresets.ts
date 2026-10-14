/**
 * CAMERA moves — presets that animate the composition's 3D camera.
 *
 * Same shape as the other shipped arrays, with one gate the library did not
 * need before: `requires: 'camera'`. A camera preset keyframes props only a
 * camera layer reads (`orbitYaw`, `focalLength`, camera-space `z`), so applied
 * to a rectangle it would either do nothing or — worse, since `z` is in
 * `THREE_D_PROPS` — flip the layer's 3D switch and shove it through depth.
 * `applyPreset` refuses non-camera targets outright, and the panel greys the
 * row out with the reason, exactly as text presets do on a shape.
 *
 * ## How the values stay right on any rig
 *
 * Every track is `relative` — offsets from wherever the camera already is —
 * because a camera, unlike a fresh layer, is never at a neutral origin: it sits
 * at `z = -focalLength` (comp plane 1:1; see camera3d.ts), and its focal length
 * scales with the comp width (`defaultCamera` derives it from a ~40° FOV, so
 * f ≈ 1.39 × compW). Absolute values would teleport the rig; offsets nudge it.
 *
 * Dolly DISTANCES are measured in `compW` for the same reason the focal length
 * is: the default viewing distance is proportional to the comp width, so a push
 * authored as a fraction of it covers the same fraction of the distance to the
 * subject in a 720p comp and a 4K one. (`compMin` — `z`'s capture default — is
 * the right reference for a LAYER travelling through depth, but a CAMERA's
 * geometry is set by its lens, and the lens is set by the width.)
 *
 * Orbit and orientation stay `abs`: 8° of yaw is 8° in any comp.
 */

import {  type Keyframe } from '@motion/animation';
import type { AnimationPreset } from './animationPresets';

const FOLDER = 'Camera';

/** Same curve as the main library's SMOOTH_EASE — a camera move should feel
 *  operated, and an un-eased dolly reads as a zoom scrub. */
const SMOOTH: [number, number, number, number] = [0.4, 0, 0.2, 1];

const kfb = (t: number, value: number, bezier?: [number, number, number, number]): Keyframe => ({
  t,
  value,
  ...(bezier ? { easing: 'bezier' as const, bezier } : {}),
});

export const CAMERA_PRESETS: ReadonlyArray<AnimationPreset> = [
  {
    name: 'Push In',
    builtin: true,
    folder: FOLDER,
    category: FOLDER,
    requires: 'camera',
    description: 'Slow dolly toward the scene — a quarter of the way in, eased.',
    tracks: [
      // z increases toward 0 (toward the plane). 0.33 compW ≈ 24% of the
      // default viewing distance (f ≈ 1.39 compW) — committed, not violent.
      { prop: 'z', relative: true, unit: 'compW', keyframes: [kfb(0, 0, SMOOTH), kfb(3, 0.33)] },
    ],
  },
  {
    name: 'Pull Out',
    builtin: true,
    folder: FOLDER,
    category: FOLDER,
    requires: 'camera',
    description: 'The reveal — dolly back away from the scene.',
    tracks: [
      { prop: 'z', relative: true, unit: 'compW', keyframes: [kfb(0, 0, SMOOTH), kfb(3, -0.33)] },
    ],
  },
  {
    name: 'Orbit Sweep',
    builtin: true,
    folder: FOLDER,
    category: FOLDER,
    requires: 'camera',
    description: 'A gentle arc around the point of interest, with a slight rise.',
    tracks: [
      // Orbit props are degrees about the POI — absolute units, relative
      // offsets, so a camera already parked at 20° sweeps 12° through 28°.
      { prop: 'orbitYaw', relative: true, keyframes: [kfb(0, -8, SMOOTH), kfb(4, 8)] },
      // The pitch peaks mid-sweep and settles — a crane breathing through the
      // arc rather than a second, competing move.
      { prop: 'orbitPitch', relative: true, keyframes: [kfb(0, 0, SMOOTH), kfb(2, 2.5, SMOOTH), kfb(4, 0)] },
    ],
  },
  {
    name: 'Drift Parallax',
    builtin: true,
    folder: FOLDER,
    category: FOLDER,
    requires: 'camera',
    description: 'Small lateral drift with a slight push — the move that shows layer depth.',
    tracks: [
      // Lateral travel is what separates the depth planes; the shallow push
      // keeps it from reading as a flat pan. Both fractions of the comp width,
      // both offsets from wherever the camera stands.
      { prop: 'x', relative: true, unit: 'compW', keyframes: [kfb(0, -0.03, SMOOTH), kfb(4, 0.03)] },
      { prop: 'z', relative: true, unit: 'compW', keyframes: [kfb(0, 0, SMOOTH), kfb(4, 0.1)] },
    ],
  },
  {
    name: 'Dolly Zoom (Vertigo)',
    builtin: true,
    folder: FOLDER,
    category: FOLDER,
    requires: 'camera',
    description: 'Dolly in while the lens zooms out — framing holds, the background falls away.',
    // Everything is computed from the camera's live z / focalLength inside the
    // applier (see above) — after applying, both tracks are ordinary keyframes.
    tracks: [],
    applier: 'dollyZoom',
  },
  {
    // Camera program R1: Handheld no longer bakes wobble keyframes — it sets
    // the camera's procedural Shake (seeded noise the engine evaluates live,
    // after the aim), which the Shake rows can then ramp, reseed or turn off.
    // Same name, so projects and scripts that apply "Handheld" keep working.
    name: 'Handheld',
    builtin: true,
    folder: FOLDER,
    category: FOLDER,
    requires: 'camera',
    description: "Subtle operator wobble — sets the camera's procedural Shake (amount, rotation, frequency), live and seeded.",
    tracks: [],
    applier: 'handheldShake',
  },
];

export default CAMERA_PRESETS;
