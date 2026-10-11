/**
 * The ACTIVE camera of a composition from the document mirror's layer headers
 * (B4): the renderer's rule (camera3d.ts `activeCameraNode`, the engine's
 * threed_port `view_camera_node`) — the TOPMOST enabled camera whose in/out
 * bar contains the time. What the Layers panel's "3D" view marks (U5).
 *
 * Pure: the mirror read is injected (`MirrorCompLayersRead`), so this file
 * needs no store and a test can hand it a fake.
 */

import { flicksToSeconds } from '@motion/engine-api';
import { uiKindOf } from './layerKinds';
import { flattenCompLayers, type MirrorCompLayersRead } from './compLayers';

/**
 * The active camera's layer id at `seconds`, or null when the comp has none
 * (the default camera renders). `flattenCompLayers` lists siblings back to
 * front, so the LAST matching camera is the topmost.
 */
export function activeCameraIdOf(m: MirrorCompLayersRead, compId: string | undefined, seconds: number): string | null {
  let found: string | null = null;
  for (const id of flattenCompLayers(m, compId)) {
    const layer = m.layer(id);
    if (!layer || uiKindOf(layer) !== 'camera') continue;
    if (layer.switches.visible === false) continue;
    const t = layer.timing;
    if (t && typeof t.inPoint === 'number' && typeof t.outPoint === 'number') {
      const inS = flicksToSeconds(t.inPoint);
      const outS = flicksToSeconds(t.outPoint);
      // A zero-length bar (a header with no timing yet) does not exclude the camera.
      if (outS > inS && (seconds < inS - 1e-9 || seconds >= outS - 1e-9)) continue;
    }
    found = id;
  }
  return found;
}
