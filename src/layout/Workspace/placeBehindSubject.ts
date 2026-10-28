/**
 * Place behind subject — the "text behind the person" sandwich in one step.
 *
 * Neither After Effects nor Premiere has this as a command; their tutorials
 * all do the same three things by hand, and that is what this does, as ONE
 * undo entry:
 *
 *   1. duplicate the footage layer (the copy lands directly above it)
 *   2. the COPY keeps the subject's matte (the Object Matte cut-out and its
 *      "Roto Brush" / "Object Matte" masks); the ORIGINAL loses them, so it is
 *      the whole picture again
 *   3. the chosen layers (text, shapes, anything) move between the two:
 *      original, then them, then the cut-out copy on top
 *
 * When the footage has no matte yet, the sandwich is still built and the copy
 * is handed to the Object Matte tool: click the subject, then Propagate. The
 * Assistant's `place_behind_subject` tool can pass a point instead, and the
 * matte is then made through the shot without a click.
 */

import type { Command } from '@motion/engine-api';
import { engine, engineIdle } from '@core/engine/engineInstance';
import { reportEngineError } from '@core/engine/uiEdits';
import { paths } from '@core/engine/propRefs';
import { mirrorMaskHeaders } from '@core/mirror/effects';
import { childOrderOf } from '@core/mirror/layerTree';
import { ROTO_FROZEN_NAME, ROTO_PATH_NAME } from '@core/workspace/rotoBrushTool';
import { documentMirror } from '@stores/documentMirror';
import { t } from '@core/i18n';
import { reorderCommands } from './layerMenuEdits';

/** The mask names a subject matte travels with (rotoBrushTool.ts / the objectMatte job). */
const MATTE_MASK_NAMES = new Set([ROTO_PATH_NAME, ROTO_FROZEN_NAME, 'Object Matte']);

export interface SubjectPlan {
  /** The footage layer whose subject the layers go behind. */
  footage: string;
  /** The layers that go behind the subject, back → front. */
  behind: string[];
  /** The composition / group the layers share (the reorder's parent). */
  comp: string;
  parent: string;
}

export type PlanResult = { ok: true; plan: SubjectPlan } | { ok: false; message: string };

function isFootage(id: string): boolean {
  const m = documentMirror();
  const layer = m.layer(id);
  const source = layer?.source;
  if (!source) return false;
  const type = m.item(source)?.mediaType;
  return type === 'video' || type === 'image';
}

/**
 * Which footage and which layers, from a selection. A selected footage layer
 * is the subject's layer; with none selected it is the nearest footage layer
 * BELOW the front-most selected layer. Everything else selected goes behind.
 */
export function planPlaceBehindSubject(selection: readonly string[]): PlanResult {
  const m = documentMirror();
  const ids = selection.filter((id) => !!m.layer(id));
  if (ids.length === 0) return { ok: false, message: t('workspace.placeBehind.selectLayers', 'Select the text or shape layers to put behind the subject.') };
  const first = m.layer(ids[0]!)!;
  const parent = first.parent ?? first.comp;
  if (ids.some((id) => (m.layer(id)!.parent ?? m.layer(id)!.comp) !== parent)) {
    return { ok: false, message: t('workspace.placeBehind.sameParent', 'The layers must be in the same composition (and the same group).') };
  }
  const kids = childOrderOf(m, parent); // back → front
  const selectedFootage = ids.filter(isFootage);
  let footage: string | undefined;
  if (selectedFootage.length === 1 && ids.length > 1) footage = selectedFootage[0];
  else if (selectedFootage.length > 1) {
    return { ok: false, message: t('workspace.placeBehind.oneFootage', 'Select one footage layer (the subject’s) and the layers to put behind it.') };
  } else if (selectedFootage.length === 0) {
    const front = Math.max(...ids.map((id) => kids.indexOf(id)));
    for (let i = front - 1; i >= 0; i--) {
      if (isFootage(kids[i]!) && !ids.includes(kids[i]!)) {
        footage = kids[i];
        break;
      }
    }
    // Nothing under them: the nearest footage above will do (the layers drop under it).
    if (!footage) footage = kids.find((id) => isFootage(id));
  }
  if (!footage) return { ok: false, message: t('workspace.placeBehind.noFootage', 'There is no video or image layer to put them behind.') };
  const behind = kids.filter((id) => ids.includes(id) && id !== footage);
  if (behind.length === 0) return { ok: false, message: t('workspace.placeBehind.selectLayers', 'Select the text or shape layers to put behind the subject.') };
  return { ok: true, plan: { footage, behind, comp: first.comp, parent } };
}

export interface PlaceBehindResult {
  /** The cut-out copy on top. */
  subject: string;
  /** Whether the footage already had a matte the copy now carries. */
  hadMatte: boolean;
}

/**
 * Build the sandwich (one entry). Resolves the copy's id, or null when the
 * engine refused (already reported).
 */
export async function placeBehindSubjectEdit(plan: SubjectPlan): Promise<PlaceBehindResult | null> {
  const m = documentMirror();
  await m.loadTrees([plan.footage]);
  const masks = mirrorMaskHeaders(m.tree(plan.footage)).filter((x) => MATTE_MASK_NAMES.has(x.name));
  const hadMatte = masks.length > 0;
  const label = t('workspace.placeBehind.label', 'Place Behind Subject');
  const client = engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return null;
  }
  let ok = false;
  let subject: string | null = null;
  try {
    const dup = await client.execute({ type: 'duplicateLayers', layers: [plan.footage] });
    if (!dup.ok) {
      reportEngineError(label, dup.error);
      return null;
    }
    subject = (dup.value as { layers?: string[] }).layers?.[0] ?? null;
    if (!subject) return null;
    await engineIdle();
    const src = m.layer(plan.footage);
    const follow: Command[] = [
      { type: 'renameLayer', layer: subject, name: `${src?.name || 'Footage'} (subject)` },
      // The original shows the whole picture again: its cut-out and matte masks go.
      { type: 'setLayerMatte', layer: plan.footage, frames: [] },
    ];
    if (masks.length > 0) {
      follow.push({ type: 'removePropertyGroups', groups: masks.map((x) => ({ layer: plan.footage, path: paths.maskGroup(x.id) })) });
    }
    // The copy sits right above the original; the layers go between the two.
    const kids = childOrderOf(m, plan.parent);
    const withCopy = kids.includes(subject) ? kids : (() => {
      const at = kids.indexOf(plan.footage);
      return [...kids.slice(0, at + 1), subject, ...kids.slice(at + 1)];
    })();
    const moving = new Set([subject, ...plan.behind]);
    const rest = withCopy.filter((id) => !moving.has(id));
    const at = rest.indexOf(plan.footage);
    const next = [...rest.slice(0, at + 1), ...plan.behind, subject, ...rest.slice(at + 1)];
    follow.push(...reorderCommands(plan.comp, plan.parent, withCopy, next, moving));
    const res = await client.batch(label, follow);
    if (!res.ok) {
      reportEngineError(label, res.error);
      return null;
    }
    ok = true;
  } finally {
    const closed = await client.endGesture(opened.value.gesture, ok);
    if (!closed.ok) reportEngineError(label, closed.error);
  }
  return ok && subject ? { subject, hadMatte } : null;
}
