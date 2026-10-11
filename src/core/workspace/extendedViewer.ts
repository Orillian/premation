/**
 * Extended Viewer (After Effects' Composition panel option, U1 of
 * docs/PROGRAM_3D_PERF_UX.md): draw layers OUTSIDE the composition frame, with
 * the frame's outline on top, so a side or custom view shows where everything
 * sits rather than a window cut out of black.
 *
 * View state (guidesStore.extendedViewer), never the document. It takes effect
 * in the views where the frame is not the picture: the axis and custom views,
 * and — as AE 26 does — Active Camera while Draft 3D is on. A final-quality
 * Active Camera view keeps the frame: through the shot camera the frame IS the
 * output, and what is outside it is not part of the shot.
 */

import { isSceneCameraView } from '@core/scene/cameraViewMode';

/** Whether a viewport in `mode` draws beyond the comp frame right now. */
export function extendedViewerActive(mode: string, draft3d: boolean, extendedViewer: boolean): boolean {
  if (!extendedViewer) return false;
  return !isSceneCameraView(mode) || draft3d;
}
