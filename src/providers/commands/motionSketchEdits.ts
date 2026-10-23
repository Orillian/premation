/**
 * Motion Sketch's write (B4 round 7; one gesture since the performance
 * program, docs/PERFORMANCE_ANIMATION_PLAN.md §3.3).
 *
 * The take (`takeMotionSketch`, x / y at composition seconds) becomes ONE
 * `setKeyframes` per Position track, sent through the take's own engine
 * gesture — the same gesture the recording drag wrote its live keys through.
 * Each track is rebuilt from the keys it had when the take was ARMED: those
 * outside the recorded span kept exactly (ids, eases, tangents), the take's
 * keys inside it. The live per-frame keys the drag left are gone with them,
 * the whole take is one undo entry, and Esc reverts it.
 *
 * Three reductions (Settings ▸ Performance Recording): `smart` writes the
 * time-aware fit (eases + path handles, holds), `everyFrame` and `smooth`
 * write today's classic tracks — linear keys, holds kept as holds.
 *
 * An unseparated Position gets vector keys (a 3D layer keeps its Z at the
 * span's start, with a zero Z tangent); separated dimensions get scalar keys
 * at the same times.
 */

import type { Command, Keyframe, PropRef, Value } from '@motion/engine-api';
import type { Keyframe as TsKeyframe } from '@motion/animation';
import {
  armMotionSketch,
  fitMotionSketch,
  takeMotionSketch,
  type MotionSketchOptions,
} from '@core/animation/motionSketch';
import type { SketchSample } from '@core/rig/puppetSketch';
import type { FittedKey } from '@core/performance/fitTake';
import { engine, engineGeneration } from '@core/engine/engineInstance';
import { compTime, values } from '@core/engine/propRefs';
import { edit } from '@core/engine/uiEdits';
import { numbersOfValue } from '@core/mirror/trackIndex';
import { documentMirror } from '@stores/documentMirror';
import { trackRef } from '@layout/Inspector/inspectorEdits';

type Ref = NonNullable<ReturnType<typeof trackRef>>;

/** Keys of each Position track when the take was armed, by API path. */
type Snapshot = Map<string, readonly Keyframe[]>;

interface Armed {
  nodeId: string;
  originals: Snapshot;
  generation: number;
}

let armed: Armed | null = null;

function positionRefs(nodeId: string): { rx: Ref; ry: Ref } | null {
  const rx = trackRef(nodeId, 'x');
  const ry = trackRef(nodeId, 'y');
  return rx && ry ? { rx, ry } : null;
}

function snapshot(nodeId: string): Snapshot {
  const m = documentMirror();
  const out: Snapshot = new Map();
  const refs = positionRefs(nodeId);
  if (!refs) return out;
  for (const r of [refs.rx, refs.ry]) out.set(r.ref.path, m.keyframes(nodeId, r.ref.path).slice());
  return out;
}

/**
 * Arm a take on `nodeId`: snapshot its Position keys (what the take's write
 * rebuilds from, before the drag writes anything) and arm the recorder.
 */
export function armMotionSketchEdit(nodeId: string, opts?: MotionSketchOptions): void {
  armed = { nodeId, originals: snapshot(nodeId), generation: engineGeneration() };
  armMotionSketch(nodeId, opts);
}

/** Forget the armed snapshot (Esc — the recorder's own cancel reverts the writes). */
export function disarmMotionSketchEdit(): void {
  armed = null;
}

function key(time: number, value: Value, k: Partial<Pick<Keyframe, 'easing' | 'bezier' | 'spatialIn' | 'spatialOut'>>): Keyframe {
  return {
    id: '',
    time,
    value,
    easing: k.easing ?? 'linear',
    ...(k.bezier ? { bezier: k.bezier } : {}),
    continuous: false,
    roving: false,
    spatialInterp: 'legacy',
    spatialIn: k.spatialIn ?? [],
    spatialOut: k.spatialOut ?? [],
    label: 0,
    dims: [],
  };
}

/** The track rebuilt: original keys outside [t0, t1] (comp flicks), then `inside`, in time order. */
function rebuilt(original: readonly Keyframe[], inside: Keyframe[], t0: number, t1: number): Keyframe[] {
  const kept = original.filter((k) => k.time < t0 - 1 || k.time > t1 + 1);
  return [...kept, ...inside].sort((a, b) => a.time - b.time);
}

/** One recorded instant on both axes, as the writer needs it. */
interface TakeKey {
  t: number;
  x: number;
  y: number;
  easing: Keyframe['easing'];
  bezier?: Keyframe['bezier'];
  /** Path handles (x, y), when the fit made them. */
  si?: [number, number];
  so?: [number, number];
}

function fromClassic(xs: readonly TsKeyframe[], ys: readonly TsKeyframe[]): TakeKey[] {
  return xs.map((k, i) => ({ t: k.t, x: k.value, y: ys[i]?.value ?? 0, easing: k.easing === 'hold' ? 'hold' : 'linear' }));
}

function fromFitted(keys: readonly FittedKey[]): TakeKey[] {
  return keys.map((k) => ({
    t: k.t,
    x: k.value[0]!,
    y: k.value[1]!,
    easing: k.easing,
    ...(k.bezier ? { bezier: k.bezier } : {}),
    ...(k.spatialIn.length >= 2 ? { si: [k.spatialIn[0]!, k.spatialIn[1]!] as [number, number] } : {}),
    ...(k.spatialOut.length >= 2 ? { so: [k.spatialOut[0]!, k.spatialOut[1]!] as [number, number] } : {}),
  }));
}

/** The commands that write `take` on `nodeId`'s Position, or null when Position is not addressable. */
async function takeCommands(nodeId: string, take: readonly TakeKey[], originals: Snapshot): Promise<Command[] | null> {
  if (take.length === 0) return [];
  const refs = positionRefs(nodeId);
  if (!refs) return null;
  const { rx, ry } = refs;
  const t0 = compTime(take[0]!.t);
  const t1 = compTime(take[take.length - 1]!.t);
  const orig = (r: Ref): readonly Keyframe[] => originals.get(r.ref.path) ?? documentMirror().keyframes(nodeId, r.ref.path);
  if (rx.ref.path === ry.ref.path) {
    const is3d = rx.members.length > 2;
    let z = 0;
    if (is3d) {
      const res = await engine().query({ type: 'getPropertyValues', props: [rx.ref], time: t0, evaluated: false });
      z = res.ok ? numbersOfValue(res.value.values[0]?.value ?? values.scalar(0))[2] ?? 0 : 0;
    }
    const tan = (v: [number, number] | undefined): number[] => (v ? (is3d ? [v[0], v[1], 0] : [v[0], v[1]]) : []);
    const inside = take.map((k) => key(compTime(k.t), is3d ? values.vec3(k.x, k.y, z) : values.vec2(k.x, k.y), {
      easing: k.easing,
      ...(k.bezier ? { bezier: k.bezier } : {}),
      spatialIn: tan(k.si),
      spatialOut: tan(k.so),
    }));
    return [{ type: 'setKeyframes', prop: rx.ref, keys: rebuilt(orig(rx), inside, t0, t1) }];
  }
  const scalarTrack = (r: Ref, pick: (k: TakeKey) => number): Command => ({
    type: 'setKeyframes',
    prop: r.ref as PropRef,
    keys: rebuilt(orig(r), take.map((k) => key(compTime(k.t), values.scalar(pick(k)), {
      easing: k.easing,
      ...(k.bezier ? { bezier: k.bezier } : {}),
    })), t0, t1),
  });
  return [scalarTrack(rx, (k) => k.x), scalarTrack(ry, (k) => k.y)];
}

/** What a re-fit needs: the last written take, valid while the document has not moved since. */
interface LastTake {
  nodeId: string;
  raw: SketchSample[];
  opts: MotionSketchOptions;
  spatial: boolean;
  originals: Snapshot;
  revision: number;
}

let lastTake: LastTake | null = null;

/** True while the last take can still be re-fitted (nothing else has edited the document since). */
export function canRefitLastTake(): boolean {
  return lastTake !== null && documentMirror().revision === lastTake.revision;
}

/**
 * End the armed recording and write it as ONE entry, through the take's
 * gesture. Resolves to the keys written per axis (0 = nothing; the gesture is
 * then reverted, so the drag's live keys do not survive a take that recorded
 * nothing).
 */
export async function finishMotionSketchEdit(): Promise<number> {
  const take = takeMotionSketch();
  const arm = armed;
  armed = null;
  if (!take) return 0;
  const originals = arm && arm.nodeId === take.nodeId ? arm.originals : snapshot(take.nodeId);
  const refs = positionRefs(take.nodeId);
  const spatial = !!refs && refs.rx.ref.path === refs.ry.ref.path;
  const keys = take.opts.reduction === 'smart'
    ? fromFitted(take.raw.length > 0 ? fitMotionSketch(take.raw, take.opts, spatial) : [])
    : fromClassic(take.tracks.x, take.tracks.y);
  const cmds = keys.length > 0 ? await takeCommands(take.nodeId, keys, originals) : null;
  if (!cmds || cmds.length === 0) {
    await take.txn.cancel();
    return 0;
  }
  if (arm && arm.generation !== engineGeneration()) {
    // The engine restarted mid-take: the gesture died with it (and its live
    // keys with the old process). The samples are still here — write the take
    // as one fresh entry rather than losing it (plan §8.2).
    void take.txn.cancel();
    const res = await edit('Motion Sketch', cmds);
    if (!res.ok) return 0;
  } else {
    take.txn.send('Motion Sketch', cmds, { keep: true });
    await take.txn.end(true);
  }
  await documentMirror().whenIdle();
  lastTake = { nodeId: take.nodeId, raw: take.raw, opts: take.opts, spatial, originals, revision: documentMirror().revision };
  return keys.length;
}

/**
 * Re-fit the last take at another Detail (the Performance bar's control after
 * a take): one entry per adjustment, rebuilt from the same armed-time
 * snapshot, so it replaces the take's keys and nothing else. Resolves to the
 * keys written, or 0 when the take can no longer be re-fitted.
 */
export async function refitLastTake(detail: number): Promise<number> {
  const last = lastTake;
  if (!last || !canRefitLastTake()) return 0;
  const opts: MotionSketchOptions = { ...last.opts, reduction: 'smart', detail };
  const keys = fromFitted(fitMotionSketch(last.raw, opts, last.spatial));
  const cmds = await takeCommands(last.nodeId, keys, last.originals);
  if (!cmds || cmds.length === 0) return 0;
  const res = await edit('Adjust Take Detail', cmds);
  if (!res.ok) return 0;
  await documentMirror().whenIdle();
  lastTake = { ...last, opts, revision: documentMirror().revision };
  return keys.length;
}
