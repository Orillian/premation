/**
 * Takes kept in the project (docs/PERFORMANCE_ANIMATION_PLAN.md §4.1, D5):
 * the Detail control's re-fit FROM THE DOCUMENT.
 *
 * The recorders (motionSketchEdits, performanceScrub) store each take beside
 * its keys, in the same engine entry — `setPerformanceTake` on the layer,
 * keyed by the property's path. While a recorder still holds the take in
 * memory the Detail control re-fits that (one armed-time snapshot, strict
 * about nothing else having edited since). When it is gone — the project was
 * saved and reopened, the take was undone and redone, another layer was
 * recorded — this module re-fits the stored one: the samples and fit come
 * from the document, and the keys of the track outside the take's span are
 * kept as they are now.
 *
 * Every write goes through the engine API; nothing here is state.
 */

import type { Command, PerformanceFit, PerformanceTake, Value } from '@motion/engine-api';
import type { FittedKey } from '@core/performance/fitTake';
import { keysOutsideSpan, unpackSamples } from '@core/performance/takeRecord';
import { fitMotionSketch } from '@core/animation/motionSketch';
import { engine } from '@core/engine/engineInstance';
import { compTime } from '@core/engine/propRefs';
import { edit } from '@core/engine/uiEdits';
import { documentMirror } from '@stores/documentMirror';
import type { PerformanceTarget } from '@stores/performanceStore';
import { trackRef } from '@layout/Inspector/inspectorEdits';
import { positionTakeCommands, positionTakePath, positionTakePaths, sketchOptionsOfFit, type Snapshot } from './motionSketchEdits';
import { fitScrubSamples, scrubOptionsOfFit, scrubTakeCommands, scrubTrackName } from './performanceScrub';

/** The document key of a take on `nodeId`'s `target`, or null when the property is not addressable. */
export function performanceTakePath(nodeId: string, target: PerformanceTarget): string | null {
  if (target === 'position') return positionTakePath(nodeId);
  return trackRef(nodeId, scrubTrackName(target))?.ref.path ?? null;
}

/** The layer's stored takes (empty when it has none or the engine cannot answer). */
export async function loadPerformanceTakes(nodeId: string): Promise<PerformanceTake[]> {
  try {
    const res = await engine().query({ type: 'getPerformanceTakes', layer: nodeId });
    return res.ok ? res.value.takes : [];
  } catch {
    return [];
  }
}

/** The stored take for `nodeId`'s `target`, or null. */
export async function loadPerformanceTake(nodeId: string, target: PerformanceTarget): Promise<PerformanceTake | null> {
  const path = performanceTakePath(nodeId, target);
  if (!path) return null;
  return (await loadPerformanceTakes(nodeId)).find((take) => take.path === path) ?? null;
}

/** Whether the document holds a take for `nodeId`'s `target` (what the bar's Detail control can re-fit). */
export async function hasStoredTake(nodeId: string, target: PerformanceTarget): Promise<boolean> {
  return (await loadPerformanceTake(nodeId, target)) !== null;
}

/** The take's keys at `detail`, and the commands writing them with the take's new fit. */
async function refitCommands(nodeId: string, target: PerformanceTarget, take: PerformanceTake, detail: number): Promise<{ keys: FittedKey[]; cmds: Command[] } | null> {
  const samples = unpackSamples(take);
  if (samples.length === 0) return null;
  const fit: PerformanceFit = { ...take.fit, reduction: 'smart', detail };
  let keys: FittedKey[];
  let cmds: Command[] | null;
  if (target === 'position') {
    const paths = positionTakePaths(nodeId);
    if (!paths) return null;
    const spatial = paths.length === 1;
    keys = fitMotionSketch(samples.map((s) => ({ t: s.t, x: s.v[0] ?? 0, y: s.v[1] ?? 0 })), sketchOptionsOfFit(take.fit, detail), spatial);
    if (keys.length === 0) return null;
    const originals: Snapshot = new Map();
    for (const p of paths) originals.set(p, keysOutsideSpan(documentMirror().keyframes(nodeId, p), take.span));
    cmds = await positionTakeCommands(nodeId, keys, originals);
    fit.spatial = spatial;
  } else {
    const r = trackRef(nodeId, scrubTrackName(target));
    if (!r) return null;
    const kind = await valueKind(r.ref, take.span.start);
    if (!kind) return null;
    keys = fitScrubSamples(samples, scrubOptionsOfFit(take.fit, detail));
    if (keys.length === 0) return null;
    cmds = scrubTakeCommands(r.ref, kind, keysOutsideSpan(documentMirror().keyframes(nodeId, r.ref.path), take.span), keys);
  }
  if (!cmds || cmds.length === 0) return null;
  const start = compTime(keys[0]!.t);
  const end = compTime(keys[keys.length - 1]!.t);
  cmds.push({ type: 'setPerformanceTake', take: { ...take, fit, span: { start, duration: Math.max(0, end - start) } } });
  return { keys, cmds };
}

/** The kind of a property's value (scalar / vec2 / vec3), as the scrub writer needs it. */
async function valueKind(prop: { layer: string; path: string }, time: number): Promise<Value['kind'] | null> {
  const fromMirror = documentMirror().keyframes(prop.layer, prop.path)[0]?.value.kind;
  if (fromMirror) return fromMirror;
  const res = await engine().query({ type: 'getPropertyValues', props: [prop], time, evaluated: false });
  return res.ok ? res.value.values[0]?.value.kind ?? null : null;
}

/**
 * Re-fit the take the document holds for `nodeId`'s `target` at `detail`: one
 * entry ("Adjust Take Detail") that replaces the keys inside the take's span
 * with the new fit, keeps every other key of the track, and records the new
 * fit on the take. Resolves to the keys written, or 0 when there is no stored
 * take or it cannot be written.
 */
export async function refitStoredTake(nodeId: string, target: PerformanceTarget, detail: number): Promise<number> {
  const take = await loadPerformanceTake(nodeId, target);
  if (!take) return 0;
  const plan = await refitCommands(nodeId, target, take, detail);
  if (!plan) return 0;
  const res = await edit('Adjust Take Detail', plan.cmds);
  if (!res.ok) return 0;
  await documentMirror().whenIdle();
  return plan.keys.length;
}
