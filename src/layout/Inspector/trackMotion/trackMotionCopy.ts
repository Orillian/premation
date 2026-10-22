/**
 * Track Motion — the pure half: the window-size presets, the mode copy and
 * the one-word feature verdict. No React, no store, so each is a fact a test
 * can pin without mounting the section.
 *
 * Moved out of `TrackMotionSection.tsx` verbatim (2026-09-04) when that file
 * was split into the section, these helpers, the tracker actions and the
 * advanced controls.
 */

import type { AutoPlanSummary, TrackerMode } from '@stores/trackerStore';
import { t } from '@core/i18n';

export const FEATURE_SIZES = [5, 10, 15, 20];
export const SEARCH_SIZES = [12, 24, 40, 60];

/**
 * The preset sizes, plus whatever is actually set if it is not one of them.
 *
 * One-click sizes both windows from measurement, so the value is routinely
 * something like 8 or 22 — and a `<select>` whose `value` matches no `<option>`
 * does not show blank, it shows the FIRST option. The panel would have read
 * "11×11" while the tracker used 17×17, which is worse than having no readout
 * at all: it is a wrong number in the place people look to check.
 */
export function sizeOptions(presets: readonly number[], current: number): number[] {
  return presets.includes(current) ? [...presets] : [...presets, current].sort((a, b) => a - b);
}

/** Display label per mode. A function so `t()` runs after the catalogue loads. */
export function modeLabels(): Record<TrackerMode, string> {
  return {
  follow: t('inspector.trackMotion.modeFollow', 'Follow (position)'),
  transform: t('inspector.trackMotion.modeTransform', 'Follow + rotation & scale'),
  stabilize: t('inspector.trackMotion.modeStabilize', 'Stabilize'),
  smooth: t('inspector.trackMotion.modeSmooth', 'Smooth stabilize (dense)'),
  corner: t('inspector.trackMotion.modeCorner', 'Planar / Corner pin'),
  mask: t('inspector.trackMotion.modeMask', 'Track mask'),
  planar: t('inspector.trackMotion.modePlanar', 'Planar tracker (surface)'),
  camera: t('inspector.trackMotion.modeCamera', '3D Camera Tracker'),
  face: t('inspector.trackMotion.modeFace', 'Face tracking'),
  };
}

/** One-paragraph explanation per mode. A function for the same reason. */
export function modeHints(): Record<TrackerMode, string> {
  return {
  follow: t('inspector.trackMotion.hintFollow', 'Drag the point onto the feature to follow, track, then apply as position keyframes on a target layer.'),
  transform: t('inspector.trackMotion.hintTransform',
    'Two points: the ANCHOR drives position, the anchor→reference vector drives rotation and scale. Put both on the same rigid surface.'),
  stabilize: t('inspector.trackMotion.hintStabilize', 'Drag the point onto the feature to lock, track, then apply — this layer moves inversely so the feature stays put.'),
  smooth: t('inspector.trackMotion.hintSmooth',
    'No points to place: dense optical flow measures the camera’s motion. Default = global similarity (Warp Stabilizer-class). Subspace / rolling-shutter variants bake a Mesh Warp lattice instead.'),
  corner: t('inspector.trackMotion.hintCorner', 'Planar track: drag corners onto the plane (TL, TR, BR, BL). “Dense grid” tracks a feature lattice inside the quad and fits the plane by RANSAC, so partial occlusion cannot drag it. Track, then pin / mesh / Solve 3D Camera Tracker (SfM + bundle adjustment). Two+ quads → Create Nulls per Plane.'),
  mask: t('inspector.trackMotion.hintMask', 'Tracks every vertex of this layer’s mask and writes mask keyframes — the mask follows the footage. Seed Matte and Segment run the SAM model in the engine; Roto Brush propagates that matte through the shot.'),
  planar: t('inspector.trackMotion.hintPlanar', 'Mocha-class planar tracking: drag the four corners around a flat, textured REGION (TL, TR, BR, BL). Everything inside it is tracked as one plane, so the corners can leave the frame or be covered. Exclude masks over occluders. Surface Adjust puts the insert’s corners anywhere on that plane. Apply as a corner pin.'),
  camera: t('inspector.trackMotion.hintCamera', 'Analyses the shot automatically: features across the frame, the camera’s path and lens, and the scene’s points. Then pick track points in the viewer to set the ground plane, or create a text, solid, null or shadow catcher on them.'),
  face: t('inspector.trackMotion.hintFace', 'Draw a mask around the face first. Outline Only follows the face outline as a mask; Detailed Features adds masks for eyes, brows and mouth and nulls for the eyes, pupils, nose, mouth and chin.'),
  };
}

/**
 * How trustworthy the chosen feature is, as one word.
 *
 * Distinctness is the deciding measurement, not strength: a high-contrast
 * feature with look-alikes around it is the one that produces a confident,
 * wrong track, and that is precisely the case a number nobody reads would
 * fail to warn about.
 */
export function qualityOf(plan: AutoPlanSummary): { level: 'good' | 'fair' | 'poor'; label: string } | null {
  // Not measured: no verdict (a badge the engine did not earn is worse than none).
  if (plan.distinctness === null) return null;
  if (plan.distinctness >= 0.6) return { level: 'good', label: t('inspector.trackMotion.qualityStrong', 'Strong feature') };
  if (plan.distinctness >= 0.35) return { level: 'fair', label: t('inspector.trackMotion.qualityUsable', 'Usable feature') };
  return { level: 'poor', label: t('inspector.trackMotion.qualityAmbiguous', 'Ambiguous feature') };
}

