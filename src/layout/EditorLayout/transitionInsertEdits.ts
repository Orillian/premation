/**
 * The Library's Transitions through the engine API (B3z, ENGINE_API.md §15.9
 * off-document builders).
 *
 * A transition item applies in one of two modes (`applyTransitionItem`):
 *   solid  comp-covering panel(s) choreographed over the cut — NEW layers
 *          (their keys, masks and blur effect included), so the builder runs
 *          off-document and the panels land as ONE `pasteLayers`;
 *   layer  the in/out rig keyed onto the selected layers' own tracks.
 *
 * Layer mode is tried first when the selection holds content layers —
 * `layerTransitionEdit`, one engine gesture: the recipe keys a scratch copy of
 * the layers' stored keyframes (core/engine/memberEdits.ts) against poses read
 * on the mirror, the Blur effect it keys is added with a caller-chosen id, and
 * the keys land as setMemberKeyframes with the motion-blur switch.
 */

import { flicksToSeconds, secondsToFlicks, type Command, type Rect } from '@motion/engine-api';
import { reportEngineError } from '@core/engine/uiEdits';
import { activeInsertTarget } from '@layout/Scene/activeInsertTarget';
import {
  getTransitionItem,
  planLayerTransition,
  type ApplyTransitionResult,
  type CompBox,
  type LayerTransitionPlan,
  type TransitionLayerFacts,
} from '@core/library/transitionLibrary';
import { useSelectionStore } from '@stores/selectionStore';
import { engine } from '@core/engine/engineInstance';
import { memberKeyframeCommands, runWithKeyTimes } from '@core/engine/memberEdits';
import { mirrorEffectHeaders } from '@core/mirror/effects';
import { settingsFps } from '@core/mirror/compFacts';
import { storedNumber, trackRefIn } from '@core/mirror/trackIndex';
import { buildTransitionPanels, type BuiltTransitionPanels } from '@core/library/transitionFragment';
import { previewChoreography } from '@core/library/insertPreview';
import { insertFragment } from '@/engine-client/insertFragment';
import { uiKindOf } from '@core/mirror/layerKinds';
import { getTime as getPlayheadTime } from '@stores/playbackClockStore';
import { documentMirror } from '@stores/documentMirror';
import type { AnimationEngine } from '@motion/animation';
import type { TransitionPayload } from '@core/library/premium/packFormat';
import { planSpecTransition, type SpecTransitionPlan } from '@core/library/premium/transitionSpec';
import { effectDefFor } from '@core/effects/effects';
import { paramValue } from '@layout/Effects/effectEdits';
import type { PropertyInit } from '@motion/engine-api';

/** A spec's effect init values as typed `addEffect` params; keys the effect does not declare are dropped. */
function effectInit(type: string, init: Record<string, number | string | boolean> | undefined): PropertyInit[] {
  const def = effectDefFor(type);
  if (!def || !init) return [];
  const out: PropertyInit[] = [];
  for (const [key, raw] of Object.entries(init)) {
    const p = def.params.find((x) => x.key === key);
    const v = p ? paramValue(null, '', p, raw as never) : null;
    if (p && v) out.push({ path: key, value: v });
  }
  return out;
}

/**
 * Apply a transition item at the playhead. Solid mode is ONE undo entry
 * (`pasteLayers` of the panels, which end up selected). Resolves to what was
 * applied, or null when nothing could be (a refusal is toasted).
 */
export async function applyTransitionEdit(
  transId: string,
  label: string,
  /**
   * A timeline drop: the one layer it landed on, and the comp time the recipe
   * starts at (its in-point for an entrance, its out-point minus the recipe's
   * length for an exit). Absent: the selection, at the playhead.
   */
  at?: { layer: string; time: number },
): Promise<ApplyTransitionResult | null> {
  const comp = activeInsertTarget()?.comp;
  const item = getTransitionItem(transId);
  if (!comp || !item) return null;
  // Layer mode: the recipe keys the target layers' own tracks. (Not
  // `addTransition`: these recipes are keyframe choreography on any layer,
  // not a cut transition between two bars.)
  if (at) {
    // A drop names its layer: never fall back to inserting a solid.
    return item.solidOnly ? null : layerTransitionEdit(bundledPlanner(transId), label, [at.layer], at.time);
  }
  if (!item.solidOnly && layerTargets().length > 0) {
    const keyed = await layerTransitionEdit(bundledPlanner(transId), label);
    if (keyed) return keyed;
  }
  // Solid mode: the panels laid into a fragment, ONE pasteLayers entry, selected.
  const t0 = getPlayheadTime();
  let made: BuiltTransitionPanels | null = null;
  const ids = await insertFragment(label, (b, f) => {
    made = buildTransitionPanels(b, f, transId, t0);
    return made?.panels ?? null;
  }, { comp });
  const r = made as BuiltTransitionPanels | null;
  if (!ids || ids.length === 0 || !r) return null;
  for (const id of ids) transitionPanels.add(id);
  // Rest half-covered (solidRestTime): the midpoint hides the comp, the end shows nothing.
  previewChoreography({ from: t0, to: t0 + r.duration, restAt: t0 + r.restAfter });
  // Insert order (the paste returns the front-most panel first).
  return { mode: 'solid', nodeIds: [...ids].reverse() };
}

/**
 * The panels this session's solid-mode transitions inserted. A panel left
 * selected by the previous apply is scenery for a cut, not content — the next
 * apply inserts its own panel instead of keying onto it
 * (transitionLibrary.ts TRANSITION_PANEL_PROP). B4-gap: the API does not
 * report the stored `__transitionPanel` mark, so a panel from an earlier
 * session reads as content.
 */
const transitionPanels = new Set<string>();

/** The selected content layers a layer-mode transition keys (no cameras / lights / audio, no panels). */
function layerTargets(): string[] {
  const m = documentMirror();
  return useSelectionStore.getState().ids.filter((id) => {
    const l = m.layer(id);
    if (!l || transitionPanels.has(id)) return false;
    const k = uiKindOf(l);
    return k !== 'camera' && k !== 'light' && k !== 'audio';
  });
}

/** The comp seconds of `flicks` on a `fps` grid, as `detectPhase` frames. */
const toFrame = (flicks: number, fps: number): number => Math.round(flicksToSeconds(flicks) * fps);

/**
 * The facts a layer-mode recipe reads, from the mirror (static transform,
 * bar, effects) and the engine (each layer's content box at the playhead,
 * `getLayerBounds` in layer space — a group's box is its children's union, off
 * its own origin).
 */
async function layerFacts(targets: readonly string[], t0: number): Promise<TransitionLayerFacts> {
  const m = documentMirror();
  const bounds = new Map<string, Rect>();
  const res = await engine().query({ type: 'getLayerBounds', layers: [...targets], time: secondsToFlicks(t0), space: 'layer', includeEffects: false });
  if (res.ok) for (const b of res.value.bounds) bounds.set(b.layer, b.bounds);
  const stat = (id: string, track: string, fallback: number): number => {
    const r = trackRefIn(m.tree(id), track);
    return (r ? storedNumber(r, r.info.value) : undefined) ?? fallback;
  };
  return {
    pose: (id) => {
      if (!m.layer(id)) return null;
      const x = stat(id, 'x', 0);
      const y = stat(id, 'y', 0);
      const scaleX = stat(id, 'scaleX', 1);
      const scaleY = stat(id, 'scaleY', 1);
      const rotation = stat(id, 'rotation', 0);
      const b = bounds.get(id);
      if (b && b.width > 0 && b.height > 0) {
        return {
          x, y, scaleX, scaleY, rotation, width: b.width, height: b.height,
          // The content centre in the layer's own space, scaled — zero for a box centred on its position.
          offsetX: (b.x + b.width / 2) * scaleX,
          offsetY: (b.y + b.height / 2) * scaleY,
        };
      }
      return { x, y, scaleX, scaleY, rotation, width: 100, height: 100 };
    },
    clips: (id) => {
      const l = m.layer(id);
      const fps = settingsFps(l ? m.comp(l.comp)?.settings : undefined);
      return { fps, clips: l ? [{ start: toFrame(l.timing.inPoint, fps), end: toFrame(l.timing.outPoint, fps) }] : [] };
    },
    effects: (id) => mirrorEffectHeaders(m.tree(id)),
  };
}

/**
 * What a layer-mode edit keys: a bundled recipe (by id) or a premium spec
 * (data). Either plans onto the scratch engine and names the effects to add
 * first, with the ids its keys already use.
 */
interface LayerPlanner {
  duration: number;
  motionBlur: boolean;
  plan: (
    targets: readonly string[], t0: number, box: CompBox, facts: TransitionLayerFacts,
    scratch: AnimationEngine, keyTime: (nodeId: string, compSeconds: number) => number,
  ) => { result: ApplyTransitionResult | null; needFx: SpecTransitionPlan['needFx'] };
}

function bundledPlanner(transId: string): LayerPlanner {
  const item = getTransitionItem(transId);
  return {
    duration: item?.duration ?? 0,
    motionBlur: !!item?.motionBlur,
    plan: (targets, t0, box, facts, scratch, keyTime) => {
      const p: LayerTransitionPlan = planLayerTransition(transId, targets, t0, box, facts, scratch, keyTime);
      return { result: p.result, needFx: p.needBlur.map((b) => ({ layer: b.layer, id: b.id, type: 'blur' })) };
    },
  };
}

/**
 * Apply a premium transition spec in layer mode — onto the selected layers at
 * the playhead, or onto the one layer a timeline drop names (`at`). A spec has
 * no solid fallback: with nothing to key it resolves to null and the caller
 * says to select a layer. One undo entry.
 */
export async function applyTransitionSpecEdit(
  spec: TransitionPayload,
  label: string,
  at?: { layer: string; time: number },
): Promise<ApplyTransitionResult | null> {
  const planner: LayerPlanner = {
    duration: spec.duration,
    motionBlur: spec.motionBlur,
    plan: (targets, t0, box, facts, scratch, keyTime) => planSpecTransition(spec, targets, t0, box, facts, scratch, keyTime),
  };
  return at ? layerTransitionEdit(planner, label, [at.layer], at.time) : layerTransitionEdit(planner, label);
}

/** Whether a layer-mode apply would find anything to key right now (the selection's content layers). */
export function hasLayerTransitionTargets(): boolean {
  return layerTargets().length > 0;
}

/**
 * A layer-mode transition as ONE undo entry (see the file header). Resolves to
 * what was keyed, or null when the recipe keyed nothing or the engine refused
 * (toasted).
 */
async function layerTransitionEdit(
  planner: LayerPlanner,
  label: string,
  only?: readonly string[],
  startAt?: number,
): Promise<ApplyTransitionResult | null> {
  const targets = only ? [...only] : layerTargets();
  if (planner.duration <= 0 || targets.length === 0) return null;
  const t0 = startAt ?? getPlayheadTime();
  const comp = activeInsertTarget()?.comp;
  const settings = comp ? documentMirror().comp(comp)?.settings : undefined;
  const box: CompBox = { width: settings?.width || 1920, height: settings?.height || 1080 };
  let plan: ReturnType<LayerPlanner['plan']>;
  let keyCmds: Command[];
  try {
    const facts = await layerFacts(targets, t0);
    const run = await runWithKeyTimes(targets, (scratch, keyTime) => planner.plan(targets, t0, box, facts, scratch, keyTime));
    plan = run.value;
    keyCmds = memberKeyframeCommands(run.scratch);
  } catch (err) {
    reportEngineError(label, { code: 'internal', message: err instanceof Error ? err.message : String(err) });
    return null;
  }
  const result = plan.result;
  if (!result || keyCmds.length === 0) return null;
  const client = engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return null;
  }
  let ok = true;
  try {
    for (const b of plan.needFx) {
      const res = await client.execute({ type: 'addEffect', layers: [b.layer], effect: b.type, params: effectInit(b.type, b.init), id: b.id });
      if (!res.ok) throw res.error;
    }
    const cmds: Command[] = [...keyCmds];
    if (planner.motionBlur) cmds.push({ type: 'setLayerSwitches', layers: result.nodeIds, patch: { motionBlur: true } });
    const res = await client.batch(label, cmds);
    if (!res.ok) throw res.error;
  } catch (err) {
    ok = false;
    const e = err as { code?: string; message?: string };
    reportEngineError(label, e.code ? err as never : { code: 'internal', message: err instanceof Error ? err.message : String(err) });
  }
  const closed = await client.endGesture(opened.value.gesture, ok);
  if (!closed.ok) reportEngineError(label, closed.error);
  if (!ok) return null;
  useSelectionStore.getState().set(result.nodeIds);
  // An entrance settles VISIBLE at the end; an exit settles invisible by
  // definition, so it rests at its start instead.
  const anyEnter = (result.phases ?? []).some((p) => p === 'enter');
  previewChoreography({ from: t0, to: t0 + planner.duration, restAt: anyEnter ? t0 + planner.duration : t0 });
  return result;
}
