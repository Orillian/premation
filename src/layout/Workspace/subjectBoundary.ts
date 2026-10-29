/**
 * The selected subject's boundary on screen (After Effects draws it in
 * magenta while a Roto Brush / Object Matte tool is up): the subject's
 * outline — its "Object Matte" mask at the frame on screen — as one SVG path
 * in the overlay's own screen space. The Object Matte overlay and the brush
 * overlay both draw it, so the selection stays visible while it is edited.
 */

import { secondsToFlicks } from '@motion/engine-api';
import { maskPathPolyline } from '@core/effects/mask';
import { mirrorMasksAt } from '@core/mirror/masks';
import { SUBJECT_OUTLINE_NAME } from '@core/workspace/rotoBrushTool';
import { documentMirror } from '@stores/documentMirror';

/** The subject outline of `nodeId` at comp second `time` as path data, via `toScreen` (layer-local px → overlay px); '' when it has none. */
export function subjectBoundaryPath(nodeId: string, time: number, toScreen: (x: number, y: number) => { x: number; y: number }): string {
  let d = '';
  for (const mask of mirrorMasksAt(documentMirror(), nodeId, secondsToFlicks(time))) {
    if (mask.name !== SUBJECT_OUTLINE_NAME) continue;
    const flat = maskPathPolyline(mask, 4);
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const s = toScreen(flat[i]!, flat[i + 1]!);
      d += `${i === 0 ? 'M' : 'L'} ${s.x.toFixed(1)} ${s.y.toFixed(1)} `;
    }
    if (flat.length >= 6) d += 'Z ';
  }
  return d;
}
