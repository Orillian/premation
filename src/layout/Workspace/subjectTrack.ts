/**
 * Subject track — a null that follows the person (or object) Object Matte cut
 * out, so anything can ride on them with one pick-whip.
 *
 * The matte's outline is keyed per frame on the layer's "Object Matte" mask
 * (or the Roto Brush's own path). Every key's outline gives:
 *
 *   Position   the outline's area centroid, through the layer → comp matrix
 *              at that time (parenting, animation and 3D included)
 *   Scale      the outline's height against the first key's (100 % there),
 *              so a sticker parented to the null grows as the subject nears
 *   Top        the top-centre of its box, keyed on a Point Control on the
 *              null: a hat, a label or a callout's anchor
 *
 * One undo entry: the null and all its keys. The null is named after the
 * layer ("<name> · Subject"), placed just above it and not rendered.
 *
 * Key times are the mask's own key times, which are composition times for a
 * layer that starts at 0 with no stretch (the objectMatte job's case); a
 * shifted layer keys the null on the same axis the matte was keyed on.
 */

import type { BezierPath, Command } from '@motion/engine-api';
import { engine, engineIdle } from '@core/engine/engineInstance';
import { reportEngineError } from '@core/engine/uiEdits';
import { paths } from '@core/engine/propRefs';
import { controlSpecOf } from '@core/engine/controlSpecs';
import { mirrorMaskHeaders } from '@core/mirror/effects';
import { ROTO_FROZEN_NAME, ROTO_PATH_NAME } from '@core/workspace/rotoBrushTool';
import { documentMirror } from '@stores/documentMirror';
import { t } from '@core/i18n';

/** Matte outlines the tools write, in preference order. */
const OUTLINE_NAMES = ['Object Matte', ROTO_FROZEN_NAME, ROTO_PATH_NAME];

export interface OutlineStats {
  cx: number;
  cy: number;
  /** Box (layer-local px). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Area centroid and box of a closed polygon (flat x y pairs); null for fewer than three points. */
export function outlineStats(vertices: readonly number[]): OutlineStats | null {
  const n = Math.floor(vertices.length / 2);
  if (n < 3) return null;
  let a = 0;
  let cx = 0;
  let cy = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const xi = vertices[i * 2]!;
    const yi = vertices[i * 2 + 1]!;
    const xj = vertices[((i + 1) % n) * 2]!;
    const yj = vertices[((i + 1) % n) * 2 + 1]!;
    const cross = xi * yj - xj * yi;
    a += cross;
    cx += (xi + xj) * cross;
    cy += (yi + yj) * cross;
    x0 = Math.min(x0, xi);
    y0 = Math.min(y0, yi);
    x1 = Math.max(x1, xi);
    y1 = Math.max(y1, yi);
  }
  if (Math.abs(a) < 1e-9) {
    // Degenerate (a line): the vertex mean.
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx += vertices[i * 2]!;
      sy += vertices[i * 2 + 1]!;
    }
    return { cx: sx / n, cy: sy / n, x0, y0, x1, y1 };
  }
  return { cx: cx / (3 * a), cy: cy / (3 * a), x0, y0, x1, y1 };
}

/** The layer's matte outline mask and its keys (time + path), or null when it has none. */
export async function matteOutlineKeys(layer: string): Promise<{ mask: string; keys: Array<{ time: number; path: BezierPath }> } | null> {
  const m = documentMirror();
  await m.loadTrees([layer]);
  const masks = mirrorMaskHeaders(m.tree(layer));
  for (const name of OUTLINE_NAMES) {
    for (const mask of masks.filter((x) => x.name === name)) {
      const keys = m.keyframes(layer, paths.mask(mask.id, 'path'))
        .flatMap((k) => (k.value.kind === 'path' ? [{ time: k.time, path: k.value.value }] : []));
      if (keys.length > 0) return { mask: mask.id, keys };
    }
  }
  return null;
}

/** Layer-local (centre origin) → comp, through a column-major 4×4 (z = 0, perspective divide). */
function toComp(m: readonly number[], x: number, y: number): { x: number; y: number } {
  const w = (m[3] ?? 0) * x + (m[7] ?? 0) * y + (m[15] ?? 1);
  const d = Math.abs(w) < 1e-12 ? 1 : w;
  return { x: (m[0]! * x + m[4]! * y + m[12]!) / d, y: (m[1]! * x + m[5]! * y + m[13]!) / d };
}

export type SubjectTrackResult = { ok: true; nullId: string; keys: number } | { ok: false; message: string };

export async function createSubjectTrackEdit(layer: string): Promise<SubjectTrackResult> {
  const m = documentMirror();
  const src = m.layer(layer);
  if (!src) return { ok: false, message: t('workspace.subjectTrack.noLayer', 'Select the footage layer with the subject.') };
  const outline = await matteOutlineKeys(layer);
  if (!outline) {
    return { ok: false, message: t('workspace.subjectTrack.noMatte', 'This layer has no subject matte through the shot yet. Select the subject with the Object Matte tool and Propagate first.') };
  }
  const client = engine();
  // Every key's centroid / top in comp space, and its height for Scale.
  const samples: Array<{ time: number; pos: { x: number; y: number }; top: { x: number; y: number }; h: number }> = [];
  for (const k of outline.keys) {
    const s = outlineStats(k.path.vertices);
    if (!s) continue;
    const res = await client.query({ type: 'getLayerTransforms', layers: [layer], time: k.time });
    const matrix = res.ok ? res.value.transforms[0]?.matrix : undefined;
    if (!matrix) continue;
    const pos = toComp(matrix, s.cx, s.cy);
    const top = toComp(matrix, (s.x0 + s.x1) / 2, s.y0);
    const bottom = toComp(matrix, (s.x0 + s.x1) / 2, s.y1);
    samples.push({ time: k.time, pos, top, h: Math.hypot(bottom.x - top.x, bottom.y - top.y) });
  }
  if (samples.length === 0) return { ok: false, message: t('workspace.subjectTrack.noMatte', 'This layer has no subject matte through the shot yet. Select the subject with the Object Matte tool and Propagate first.') };

  const label = t('workspace.subjectTrack.label', 'Create Subject Track');
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return { ok: false, message: opened.error.message };
  }
  let ok = false;
  let nullId: string | null = null;
  try {
    const comp = src.comp;
    const stack = m.comp(comp)?.layers ?? [];
    const created = await client.execute({
      type: 'createLayer',
      comp,
      kind: 'null',
      name: `${src.name || 'Layer'} · Subject`,
      index: Math.max(0, stack.indexOf(layer)),
      init: [],
    });
    if (!created.ok) {
      reportEngineError(label, created.error);
      return { ok: false, message: created.error.message };
    }
    nullId = (created.value as { layer?: string }).layer ?? null;
    if (!nullId) return { ok: false, message: label };
    // A Point Control (ADBE Point Control, `ctrl_Point 1`): the top of the subject, for ctrl('Point 1') and pick-whips.
    const ctrl = await client.execute({ type: 'addPropertyGroup', layer: nullId, parent: 'effects', matchName: controlSpecOf('point').matchName, init: [] });
    await engineIdle();
    const h0 = samples[0]!.h || 1;
    const keys: Array<Extract<Command, { type: 'addKeyframes' }>['keys'][number]> = [];
    for (const s of samples) {
      keys.push({ prop: { layer: nullId, path: paths.transform('position') }, time: s.time, value: { kind: 'vec2', value: s.pos }, spatialIn: [], spatialOut: [] });
      const sc = (s.h / h0) * 100;
      keys.push({ prop: { layer: nullId, path: paths.transform('scale') }, time: s.time, value: { kind: 'vec2', value: { x: sc, y: sc } }, spatialIn: [], spatialOut: [] });
    }
    const fx = ctrl.ok ? (ctrl.value as { groups?: string[] }).groups?.[0]?.split('/')[1] : undefined;
    const follow: Command[] = [{ type: 'addKeyframes', keys }];
    if (fx) {
      follow.push({
        type: 'addKeyframes',
        keys: samples.map((s) => ({ prop: { layer: nullId!, path: paths.effectParam(fx, controlSpecOf('point').param) }, time: s.time, value: { kind: 'vec2' as const, value: s.top }, spatialIn: [], spatialOut: [] })),
      });
    }
    const res = await client.batch(label, follow);
    if (!res.ok) {
      reportEngineError(label, res.error);
      return { ok: false, message: res.error.message };
    }
    ok = true;
  } finally {
    const closed = await client.endGesture(opened.value.gesture, ok);
    if (!closed.ok) reportEngineError(label, closed.error);
  }
  return ok && nullId ? { ok: true, nullId, keys: samples.length } : { ok: false, message: label };
}
