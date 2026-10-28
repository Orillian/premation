/**
 * The Effects section of a layer's timeline rows, After Effects' way: one
 * twirl per applied effect ("Glow", "Glow 2"), in stack order, each with its
 * own parameters under it — not every parameter of every effect in one flat
 * list where "Radius" could belong to any of three effects.
 *
 * Pure: the caller hands in the rows and the layer's effect headers (the
 * mirror's `mirrorEffectHeaders`) with their display names.
 */

import type { TimelinePropertyTrack } from './TimelineModel';
import type { MirrorTreeLike } from '@core/mirror/trackIndex';

export interface EffectRowGroup {
  /** The effect's id; null = rows of the section that belong to no one effect (paint strokes). */
  effectId: string | null;
  label: string;
  /** The effect's fx switch (AE's Effect toggle on its twirl). */
  enabled: boolean;
  props: TimelinePropertyTrack[];
}

/** One selection of an Object Matte (AE lists them under the effect): the outline mask it is drawn as. */
export interface ObjectMatteSelection {
  maskId: string;
  name: string;
  mode: 'add' | 'subtract';
}

/** The masks the Object Matte / Roto Brush tools write (rotoBrushTool.ts, the objectMatte job). */
const SELECTION_NAMES: ReadonlySet<string> = new Set(['Object Matte', 'Roto Brush', 'Roto Brush (Frozen)']);

/**
 * The layer's Object Matte selections, in mask order: each mask the Object
 * Matte or Roto Brush tool wrote, with how it takes part (a Subtract mode or an
 * inverted mask subtracts; anything else — the tool's own None outline — adds).
 * Today a layer has one.
 */
export function objectMatteSelections(tree: MirrorTreeLike | undefined): ObjectMatteSelection[] {
  if (!tree) return [];
  const out: ObjectMatteSelection[] = [];
  for (const path of tree.nodes.get('masks')?.children ?? []) {
    const g = tree.nodes.get(path);
    if (!g || !SELECTION_NAMES.has(g.name)) continue;
    const mode = tree.nodes.get(`${path}/mode`)?.value;
    const inverted = tree.nodes.get(`${path}/inverted`)?.value;
    const subtract = (mode?.kind === 'choice' && mode.value === 'subtract') || (inverted?.kind === 'bool' && inverted.value);
    out.push({ maskId: path.slice('masks/'.length), name: g.name, mode: subtract ? 'subtract' : 'add' });
  }
  return out;
}

/** `effect.<id>.<param>` → `<id>`; null for any other row. */
export function effectIdOfRow(prop: string): string | null {
  const m = /^effect\.([^.]+)\./.exec(prop);
  return m ? m[1]! : null;
}

export function groupEffectRows(
  props: readonly TimelinePropertyTrack[],
  headers: ReadonlyArray<{ id: string; enabled: boolean }>,
  names: ReadonlyMap<string, string>,
): EffectRowGroup[] {
  const loose: TimelinePropertyTrack[] = [];
  const byId = new Map<string, TimelinePropertyTrack[]>();
  for (const p of props) {
    const id = effectIdOfRow(p.prop);
    if (id === null) {
      loose.push(p);
      continue;
    }
    let list = byId.get(id);
    if (!list) byId.set(id, (list = []));
    list.push(p);
  }
  const out: EffectRowGroup[] = [];
  if (loose.length > 0) out.push({ effectId: null, label: '', enabled: true, props: loose });
  // Stack order, as the Effect Controls panel lists them.
  for (const h of headers) {
    const list = byId.get(h.id);
    if (!list) continue;
    byId.delete(h.id);
    out.push({ effectId: h.id, label: names.get(h.id) ?? h.id, enabled: h.enabled, props: list });
  }
  // Rows of an effect the headers do not list yet (its tree still loading): kept, never dropped.
  for (const [id, list] of byId) out.push({ effectId: id, label: names.get(id) ?? id, enabled: true, props: list });
  return out;
}
