/**
 * Where a layer lands on the frame at a time, as the AI's checks need it: the
 * engine's comp-space box (`getLayerBounds`, through the 2D parent chain), and
 * for a 3D layer under a camera that box projected through the camera — the
 * engine's bounds query is 2D only, so a world laid out at z 6000 under one
 * camera read as "outside the frame" on every layer (Operand film, 2026-10-20).
 *
 * The projection is the engine's pinhole: camera-to-world rotation from
 * `sampleCamera`'s yaw / pitch / roll (cameraInterchange.ts `rotationOf`),
 * screen = comp centre + zoom · (x, y) / depth.
 */

import { flicksToSeconds, secondsToFlicks } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { rotationOf } from '@core/scene/cameraInterchange';
import { documentMirror } from '@stores/documentMirror';

export interface Box { x: number; y: number; width: number; height: number }

/** A depth (camera space, px) in front of which a corner counts as visible. */
const NEAR = 1;

/** The camera that renders `comp` at `seconds`: the topmost enabled camera whose bar covers it. */
function activeCamera(comp: string, seconds: number): string | null {
  const m = documentMirror();
  for (const id of m.comp(comp)?.layers ?? []) {
    const l = m.layer(id);
    if (!l || l.kind !== 'camera' || l.switches.visible === false) continue;
    if (seconds >= flicksToSeconds(l.timing.inPoint) && seconds < flicksToSeconds(l.timing.outPoint)) return id;
  }
  return null;
}

/**
 * Comp-space boxes of `ids` at `seconds`. A 3D layer wholly behind the camera
 * answers a box outside the frame; one that straddles the camera plane, the
 * whole frame (part of it is seen). Layers with no canvas box are absent.
 */
export async function renderedBoxes(ids: readonly string[], seconds: number): Promise<Map<string, Box>> {
  const time = secondsToFlicks(seconds);
  const flat = await engine().query({ type: 'getLayerBounds', layers: [...ids], time, space: 'comp', includeEffects: false });
  const out = new Map<string, Box>(flat.ok ? flat.value.bounds.map((b) => [b.layer, b.bounds] as const) : []);
  const m = documentMirror();
  const deep = ids.filter((id) => out.has(id) && m.layer(id)?.switches.threeD);
  if (deep.length === 0) return out;
  const byComp = new Map<string, string[]>();
  for (const id of deep) {
    const comp = m.layer(id)!.comp;
    byComp.set(comp, [...(byComp.get(comp) ?? []), id]);
  }
  for (const [comp, layers] of byComp) {
    const cam = activeCamera(comp, seconds);
    if (!cam) continue;
    const [shot, local, xf] = await Promise.all([
      engine().query({ type: 'sampleCamera', layer: cam, range: { start: time, duration: 0 }, samples: 1 }),
      engine().query({ type: 'getLayerBounds', layers, time, space: 'layer', includeEffects: false }),
      engine().query({ type: 'getLayerTransforms', layers, time }),
    ]);
    if (!shot.ok || !local.ok || !xf.ok) continue;
    const s = shot.value.samples[0];
    if (!s) continue;
    const { compWidth: cw, compHeight: ch } = shot.value;
    const [[rx, dx, fx], [ry, dy, fy], [rz, dz, fz]] = rotationOf(s.yaw ?? 0, s.pitch ?? 0, s.roll ?? 0);
    const matrixOf = new Map(xf.value.transforms.map((t) => [t.layer, t.matrix] as const));
    for (const b of local.value.bounds) {
      const mm = matrixOf.get(b.layer);
      if (!mm || b.corners.length < 8) continue;
      const pts: Array<{ x: number; y: number }> = [];
      let behind = 0;
      for (let i = 0; i < 8; i += 2) {
        const lx = b.corners[i]!, ly = b.corners[i + 1]!;
        // World point (column-major 4×4), then camera space: right, down, forward.
        const wx = mm[0]! * lx + mm[4]! * ly + mm[12]! - s.eye.x;
        const wy = mm[1]! * lx + mm[5]! * ly + mm[13]! - s.eye.y;
        const wz = mm[2]! * lx + mm[6]! * ly + mm[14]! - s.eye.z;
        const depth = fx * wx + fy * wy + fz * wz;
        if (depth < NEAR) { behind++; continue; }
        pts.push({
          x: cw / 2 + (s.zoom * (rx * wx + ry * wy + rz * wz)) / depth,
          y: ch / 2 + (s.zoom * (dx * wx + dy * wy + dz * wz)) / depth,
        });
      }
      if (behind === 4) { out.set(b.layer, { x: -2 * cw, y: -2 * ch, width: 1, height: 1 }); continue; }
      if (behind > 0) { out.set(b.layer, { x: 0, y: 0, width: cw, height: ch }); continue; }
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      const x = Math.min(...xs), y = Math.min(...ys);
      out.set(b.layer, { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y });
    }
  }
  return out;
}
