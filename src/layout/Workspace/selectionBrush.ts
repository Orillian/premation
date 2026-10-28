/**
 * Selection Brush and Refine Edge — the two Object Matte group tools that do
 * not ask the model (AE 26's group: Object Matte, Quick Selection, Selection
 * Brush, Refine Edge).
 *
 *   Selection Brush   paints the selection exactly where the brush goes: the
 *                     stroke's outline (a capsule chain of the brush radius) is
 *                     unioned into the selection's mask, or with Alt cut out of
 *                     it. No edge snapping — that is Quick Selection's job.
 *   Refine Edge       a stroke over hair or fur sets the matte's edge radius
 *                     from the brush, and turns Render Refine Edge on; it is
 *                     used on the next propagation (the refinement is baked
 *                     then, which the status says).
 *
 * The selection is the tool's "Roto Brush" mask (rotoBrushTool.ts
 * ROTO_PATH_NAME): on an animated one the edit is a key at the current time,
 * on a static one the shape itself (maskPathCommand). One undo entry each.
 */

import polygonClipping, { type MultiPolygon, type Pair, type Polygon } from 'polygon-clipping';
import { secondsToFlicks } from '@motion/engine-api';
import { edit } from '@core/engine/uiEdits';
import { mirrorMasksAt } from '@core/mirror/masks';
import { maskPathPolyline, type MaskPoint } from '@core/effects/mask';
import { ROTO_PATH_NAME } from '@core/workspace/rotoBrushTool';
import { documentMirror } from '@stores/documentMirror';
import { useRotoBrushStore } from '@stores/rotoBrushStore';
import { t } from '@core/i18n';
import { maskPathCommand } from './viewportEdits';

type Pt = { x: number; y: number };

/** A circle as a 12-gon (closed ring). */
function disc(c: Pt, r: number): Pair[] {
  const ring: Pair[] = [];
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ring.push([c.x + Math.cos(a) * r, c.y + Math.sin(a) * r]);
  }
  return ring;
}

/** The quad joining two discs of radius r (closed ring), or null for coincident points. */
function bridge(a: Pt, b: Pt, r: number): Pair[] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return null;
  const nx = (-dy / d) * r;
  const ny = (dx / d) * r;
  return [[a.x + nx, a.y + ny], [b.x + nx, b.y + ny], [b.x - nx, b.y - ny], [a.x - nx, a.y - ny], [a.x + nx, a.y + ny]];
}

/** A brush stroke's outline: every point's disc and the bridges between them, unioned. */
export function strokeOutline(points: readonly Pt[], radius: number): MultiPolygon {
  if (points.length === 0 || !(radius > 0)) return [];
  const parts: Polygon[] = [[disc(points[0]!, radius)]];
  for (let i = 1; i < points.length; i++) {
    parts.push([disc(points[i]!, radius)]);
    const q = bridge(points[i - 1]!, points[i]!, radius);
    if (q) parts.push([q]);
  }
  const [first, ...rest] = parts;
  return rest.length > 0 ? polygonClipping.union(first!, ...rest) : [first!];
}

/** The largest outer ring of a boolean result (a mask holds one loop), open (no closing pair). */
export function largestRing(multi: MultiPolygon): Pair[] | null {
  let best: Pair[] | null = null;
  let bestArea = 0;
  for (const poly of multi) {
    const ring = poly[0];
    if (!ring || ring.length < 4) continue;
    let a = 0;
    for (let i = 0; i + 1 < ring.length; i++) a += ring[i]![0] * ring[i + 1]![1] - ring[i + 1]![0] * ring[i]![1];
    if (Math.abs(a) > bestArea) {
      bestArea = Math.abs(a);
      best = ring;
    }
  }
  if (!best) return null;
  const open = best[0]![0] === best[best.length - 1]![0] && best[0]![1] === best[best.length - 1]![1] ? best.slice(0, -1) : best;
  return open.length >= 3 ? open : null;
}

const corner = ([x, y]: Pair): MaskPoint => ({ x, y, inX: x, inY: y, outX: x, outY: y });

/**
 * Brush `stroke` (layer-local px, centre origin) into the selection at comp
 * `time`: add, or with `subtract` cut away. Resolves whether anything changed.
 */
export async function applySelectionBrushEdit(nodeId: string, stroke: readonly Pt[], radius: number, subtract: boolean, time: number): Promise<boolean> {
  const brush = strokeOutline(stroke, radius);
  if (brush.length === 0) return false;
  const m = documentMirror();
  await m.loadTrees([nodeId]);
  const masks = mirrorMasksAt(m, nodeId, secondsToFlicks(time));
  const selection = [...masks].reverse().find((x) => x.name === ROTO_PATH_NAME);
  const label = subtract ? t('workspace.selectionBrush.subtract', 'Selection Brush: Subtract') : t('workspace.selectionBrush.add', 'Selection Brush: Add');
  if (!selection) {
    if (subtract) return false;
    const ring = largestRing(brush);
    if (!ring) return false;
    const res = await edit(label, {
      type: 'addMask',
      layer: nodeId,
      mode: 'add',
      inverted: false,
      name: ROTO_PATH_NAME,
      path: { vertices: ring.flatMap(([x, y]) => [x, y]), inTangents: [], outTangents: [], closed: true, featherPoints: [], vertexStates: [] },
    });
    return res.ok;
  }
  const flat = maskPathPolyline(selection);
  const ring: Pair[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) ring.push([flat[i]!, flat[i + 1]!]);
  if (ring.length < 3) return false;
  ring.push(ring[0]!);
  const result = subtract ? polygonClipping.difference([ring], ...brush) : polygonClipping.union([ring], ...brush);
  const next = largestRing(result);
  if (!next) {
    useRotoBrushStore.getState().setStatus(t('workspace.selectionBrush.empty', 'That would remove the whole selection — undo, or select again.'));
    return false;
  }
  const res = await edit(label, maskPathCommand(nodeId, selection.id, next.map(corner), true, time));
  return res.ok;
}

/** Refine Edge: the brush's radius becomes the matte's edge radius for the next propagation. */
export function applyRefineEdgeStroke(radiusLayerPx: number): void {
  const store = useRotoBrushStore.getState();
  const edgeRadius = Math.max(store.refine.edgeRadius, Math.round(radiusLayerPx));
  store.setRefine({ edgeRadius });
  store.setStatus(t('workspace.refineEdge.set', 'Refine Edge radius {n} px: used when you Propagate.', { n: edgeRadius }));
}
