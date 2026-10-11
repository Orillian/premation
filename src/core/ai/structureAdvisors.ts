/**
 * Structural advisors over the layer stack (docs/PROGRAM_3D_PERF_UX.md M2):
 * the mistakes a duplicated or over-stacked build makes that no per-layer
 * check sees, because every layer is individually fine.
 *
 * Evidence (2026-10-11): the owner's MCP-built comp carried its 6-beat script
 * TWICE with identical clip times — two `Front globals` roots, two cameras per
 * beat, three `Rainfall` adjustment layers active at once. It played laggy
 * and looked wrong, and `review_design` said nothing, because nothing was
 * off-screen, invisible or past the end.
 *
 *   duplicate-beat    two beat roots (`Beat N — <name>`, as compileScript
 *                     names them) with the same beat name, or two `Front
 *                     globals` roots: the script was built twice.
 *   cameras-live      more than one visible camera whose bars overlap: the
 *                     engine renders through the top one; the rest are dead
 *                     weight and a trap for the next edit.
 *   adjustment-stack  visible adjustment layers whose bars overlap — two with
 *                     the same name (a duplicate), or three or more of any
 *                     name: each one re-renders the whole frame beneath it.
 *                     Two DIFFERENT adjustment layers at once (a grade and a
 *                     grain) are normal and not reported.
 *
 * Pure over plain records; `sceneStructureWarnings` is the mirror glue.
 * Counts are per time range: the report says WHEN the stack exists and how
 * deep it is, not just that it does.
 */

import type { ToolContext } from '@motion/ai-tools';
import { flicksToSeconds } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';

export interface StructureLayer {
  id: string;
  name: string;
  /** The editor kind (`camera`, `adjustment`, `null`, …). */
  kind: string;
  parent: string | null;
  visible: boolean;
  /** The bar, composition seconds. */
  inSec: number;
  outSec: number;
}

export type StructureWarningKind = 'duplicate-beat' | 'cameras-live' | 'adjustment-stack';

export interface StructureWarning {
  kind: StructureWarningKind;
  nodeIds: string[];
  /** Addressed to the model: what is wrong, when, and what to do about it. */
  message: string;
}

/** The beat name a compiled beat root carries (`Beat 3 — Reveal` → `Reveal`), else null. */
export function beatNameOfRoot(layerName: string): string | null {
  const m = /^Beat \d+ — (.+)$/.exec(layerName);
  return m ? m[1]! : null;
}

export const FRONT_GLOBALS_ROOT_NAME = 'Front globals';

interface Range {
  start: number;
  end: number;
  ids: string[];
}

const r2 = (n: number): string => (Math.round(n * 100) / 100).toString();

/**
 * The maximal time ranges over which at least `min` of `items` are live at
 * once, each with the ids live in it. Adjacent ranges with the same set are
 * one range. Bars are half-open: a layer ending at 4 s and one starting at
 * 4 s do not overlap.
 */
export function overlapRanges(items: readonly { id: string; inSec: number; outSec: number }[], min: number): Range[] {
  const live = items.filter((i) => i.outSec > i.inSec);
  const cuts = [...new Set(live.flatMap((i) => [i.inSec, i.outSec]))].sort((a, b) => a - b);
  const out: Range[] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const start = cuts[k]!;
    const end = cuts[k + 1]!;
    const ids = live.filter((i) => i.inSec <= start && i.outSec >= end).map((i) => i.id);
    if (ids.length < min) continue;
    const last = out[out.length - 1];
    if (last && last.end === start && last.ids.length === ids.length && last.ids.every((id, n) => id === ids[n])) last.end = end;
    else out.push({ start, end, ids });
  }
  return out;
}

export function structureWarnings(layers: readonly StructureLayer[]): StructureWarning[] {
  const out: StructureWarning[] = [];
  const byId = new Map(layers.map((l) => [l.id, l]));
  const nameOf = (id: string): string => byId.get(id)?.name ?? id;
  const list = (ids: readonly string[]): string => ids.map((id) => `${nameOf(id)} (${id})`).join(', ');

  // ── duplicate beats ──
  const roots = new Map<string, string[]>();
  for (const l of layers) {
    if (l.parent !== null) continue;
    const beat = l.name === FRONT_GLOBALS_ROOT_NAME ? FRONT_GLOBALS_ROOT_NAME : beatNameOfRoot(l.name);
    if (beat === null) continue;
    roots.set(beat, [...(roots.get(beat) ?? []), l.id]);
  }
  for (const [beat, ids] of roots) {
    if (ids.length < 2) continue;
    out.push({
      kind: 'duplicate-beat',
      nodeIds: ids,
      message:
        `${beat === FRONT_GLOBALS_ROOT_NAME ? 'The "Front globals" root' : `Beat "${beat}"`} exists ${ids.length} times (${ids.join(', ')}): ` +
        'the script was built more than once, so every layer in it renders twice at the same time. ' +
        `Keep one: delete_layer the other root${ids.length > 2 ? 's' : ''} (its children go with it), or re-run author_scene without append.`,
    });
  }

  // ── cameras live together ──
  const cameras = layers.filter((l) => l.kind === 'camera' && l.visible);
  for (const r of overlapRanges(cameras, 2)) {
    out.push({
      kind: 'cameras-live',
      nodeIds: r.ids,
      message:
        `${r.ids.length} cameras are live at ${r2(r.start)}–${r2(r.end)}s: ${list(r.ids)}. ` +
        'Only the topmost one renders; the others are dead weight and the next camera edit lands on the wrong one. ' +
        'Trim each camera\'s bar to its own shot (set_layer_timing) or delete the extras.',
    });
  }

  // ── stacked adjustment layers ──
  const adjustments = layers.filter((l) => l.kind === 'adjustment' && l.visible);
  const reported = new Set<string>();
  const key = (ids: readonly string[], start: number, end: number): string => `${[...ids].sort().join('|')}@${start}-${end}`;
  for (const r of overlapRanges(adjustments, 2)) {
    const names = r.ids.map(nameOf);
    const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
    const deep = r.ids.length >= 3;
    if (!dupes.length && !deep) continue;
    const k = key(r.ids, r.start, r.end);
    if (reported.has(k)) continue;
    reported.add(k);
    const what = dupes.length
      ? `${dupes.map((n) => `"${n}"`).join(', ')} ${dupes.length === 1 ? 'is' : 'are'} applied more than once`
      : `${r.ids.length} full-frame passes stacked`;
    out.push({
      kind: 'adjustment-stack',
      nodeIds: r.ids,
      message:
        `${r.ids.length} adjustment layers are active at ${r2(r.start)}–${r2(r.end)}s (${what}): ${list(r.ids)}. ` +
        'Each one re-renders the whole frame beneath it, so the stack costs a full pass per layer every frame' +
        (dupes.length ? ' and a duplicated effect doubles its own strength' : '') +
        '. Keep one per job — delete the duplicates, or trim each to the beat it serves.',
    });
  }

  return out;
}

export function formatStructureWarnings(warnings: readonly StructureWarning[]): string | null {
  return warnings.length ? warnings.map((w) => `- [${w.kind}] ${w.message}`).join('\n') : null;
}

/** The active composition's structure warnings, read from the document mirror. */
export async function sceneStructureWarnings(ctx: ToolContext): Promise<StructureWarning[]> {
  const comp = await ctx.comp.get();
  const m = documentMirror();
  const layers: StructureLayer[] = (await ctx.scene.all()).map((n) => {
    const info = m.layer(n.id);
    const inSec = info ? flicksToSeconds(info.timing.inPoint) : 0;
    const outSec = info ? flicksToSeconds(info.timing.outPoint) : comp.durationSeconds;
    return {
      id: n.id,
      name: n.name,
      kind: n.kind,
      parent: n.parent,
      visible: n.visible,
      inSec: Math.max(0, inSec),
      outSec: Math.min(comp.durationSeconds, outSec),
    };
  });
  return structureWarnings(layers);
}
