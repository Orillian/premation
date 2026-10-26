/**
 * Perform on a property that is not Position (plan P0.3): Rotation, Scale or
 * Opacity, recorded by dragging left / right anywhere in the viewport while
 * the composition plays. Position is recorded by dragging the layer itself
 * (Motion Sketch, motionSketchEdits.ts); a value with no on-canvas handle is
 * recorded like a scrubby slider instead.
 *
 * Same contract as Motion Sketch: the take is ONE engine gesture — live keys
 * at the playhead while the pointer moves, then one `setKeyframes` rebuilding
 * the track from its keys at the press (outside the span kept, the fitted
 * take inside) — so it is one undo entry and Esc reverts it. Values are API
 * units (degrees, percent; plan §8.1 bounds: opacity 0–100, scale ≥ 0).
 */

import type { Command, Keyframe, PerformanceFit, PropRef, Value } from '@motion/engine-api';
import { fitTake, detailToTolerance, takeRange, type FittedKey, type TakeSample } from '@core/performance/fitTake';
import { MAX_TAKE_SAMPLES, performanceTakeOf } from '@core/performance/takeRecord';
import { t } from '@core/i18n';
import { engine, engineGeneration } from '@core/engine/engineInstance';
import { compTime, values } from '@core/engine/propRefs';
import { edit } from '@core/engine/uiEdits';
import { numbersOfValue } from '@core/mirror/trackIndex';
import { ToolTransaction } from '@core/workspace/viewportGesture';
import { documentMirror } from '@stores/documentMirror';
import type { PerformanceTarget } from '@stores/performanceStore';
import { useUIStore } from '@stores/uiStore';
import { trackRef } from '@layout/Inspector/inspectorEdits';

/** Units per screen pixel of drag, and the property's legal range. */
const SCRUB: Record<Exclude<PerformanceTarget, 'position'>, { track: string; gain: number; min: number; max: number }> = {
  rotation: { track: 'rotation', gain: 0.5, min: -Infinity, max: Infinity },
  scale: { track: 'scaleX', gain: 0.25, min: 0, max: Infinity },
  opacity: { track: 'opacity', gain: 0.25, min: 0, max: 100 },
};

/** Shift: fine control, a tenth of the gain. */
export const FINE = 0.1;

/** The legacy track name a scrub target records (`trackRef`). */
export function scrubTrackName(target: Exclude<PerformanceTarget, 'position'>): string {
  return SCRUB[target].track;
}

export interface ScrubFitOptions {
  detail: number;
  wholeFrames: boolean;
  holdSeconds: number;
  frameDuration: number;
  captureSpeedPct: number;
  /** Smart fit, or one key per sample (`everyFrame` and `smooth` both keep every sample here: a value has no path to smooth). */
  smart: boolean;
  /** What records the take, kept with it in the project (plan §4.1): mouse | hand. Default mouse. */
  source?: string;
}

/** The fit a scrub take is stored with (plan §4.1). */
export function scrubFitOf(o: ScrubFitOptions): PerformanceFit {
  return {
    reduction: o.smart ? 'smart' : 'everyFrame',
    detail: o.detail,
    captureSpeedPct: o.captureSpeedPct,
    wholeFrames: o.wholeFrames,
    holdSeconds: o.holdSeconds,
    frameDuration: o.frameDuration,
    spatial: false,
  };
}

/** Scrub fit options from a stored fit (a re-fit from the document). */
export function scrubOptionsOfFit(fit: PerformanceFit, detail: number): ScrubFitOptions {
  return {
    detail,
    wholeFrames: fit.wholeFrames,
    holdSeconds: fit.holdSeconds,
    frameDuration: fit.frameDuration,
    captureSpeedPct: fit.captureSpeedPct,
    smart: true,
  };
}

interface Scrub {
  prop: PropRef;
  /** The property's value at the press, API numbers (one per member). */
  start: number[];
  kind: Value['kind'];
  originals: readonly Keyframe[];
  samples: TakeSample[];
  last: number[];
  txn: ToolTransaction;
  generation: number;
  spec: (typeof SCRUB)[keyof typeof SCRUB];
}

let scrub: Scrub | null = null;

function valueOf(kind: Value['kind'], v: readonly number[]): Value {
  if (kind === 'vec3') return values.vec3(v[0]!, v[1]!, v[2]!);
  if (kind === 'vec2') return values.vec2(v[0]!, v[1]!);
  return values.scalar(v[0]!);
}

/**
 * Begin a scrub take on `nodeId`'s `target` at comp time `t`: reads the
 * property's value there and snapshots its keys. Resolves false when the
 * property cannot be addressed.
 */
export async function beginScrub(nodeId: string, target: Exclude<PerformanceTarget, 'position'>, t: number): Promise<boolean> {
  const spec = SCRUB[target];
  const r = trackRef(nodeId, spec.track);
  if (!r) return false;
  const res = await engine().query({ type: 'getPropertyValues', props: [r.ref], time: compTime(t), evaluated: true });
  if (!res.ok) return false;
  const value = res.value.values[0]?.value;
  if (!value) return false;
  const start = numbersOfValue(value);
  scrub = {
    prop: r.ref,
    start,
    kind: value.kind,
    originals: documentMirror().keyframes(nodeId, r.ref.path).slice(),
    samples: [{ t, v: start }],
    last: start,
    txn: new ToolTransaction(),
    generation: engineGeneration(),
    spec,
  };
  return true;
}

export function scrubActive(): boolean {
  return scrub !== null;
}

/** The pointer has moved `dx` screen px from the press: the value now, shown live and recorded at `t`. */
export function moveScrub(dx: number, t: number, fine: boolean): void {
  const s = scrub;
  if (!s) return;
  moveScrubBy(dx * s.spec.gain * (fine ? FINE : 1), t);
}

/**
 * The value `delta` property units from the value at the press (degrees,
 * percent) — the mouse's scrub above, or another source's (the hand, plan
 * P1.3) — clamped to the property's range, shown live and recorded at `t`.
 */
export function moveScrubBy(delta: number, t: number): void {
  const s = scrub;
  if (!s) return;
  // Scale: every member moves together (a uniform scrub), from its own start.
  const v = s.start.map((x) => Math.min(s.spec.max, Math.max(s.spec.min, x + delta)));
  s.last = v;
  const prev = s.samples[s.samples.length - 1];
  if (prev && t < prev.t - 1e-6) return; // time ran backwards: the take is over (plan §8.2)
  s.samples.push({ t, v });
  s.txn.send('Motion Sketch', [{ type: 'setProperty', prop: s.prop, value: valueOf(s.kind, v), time: compTime(t) }]);
}

/** A playback tick with the pointer at rest: the value holds (see `tickMotionSketch`). */
export function tickScrub(t: number): void {
  const s = scrub;
  if (!s) return;
  const prev = s.samples[s.samples.length - 1];
  if (prev && t > prev.t + 1e-6) s.samples.push({ t, v: s.last });
}

/** Esc: revert everything the take wrote. */
export function cancelScrub(): void {
  if (scrub) void scrub.txn.cancel();
  scrub = null;
}

function keyOf(kind: Value['kind'], k: FittedKey): Keyframe {
  return {
    id: '',
    time: compTime(k.t),
    value: valueOf(kind, k.value),
    easing: k.easing,
    ...(k.bezier ? { bezier: k.bezier } : {}),
    continuous: false,
    roving: false,
    spatialInterp: 'legacy',
    spatialIn: [],
    spatialOut: [],
    label: 0,
    dims: [],
  };
}

/** The fitted keys of a scrub take's samples (comp seconds, API units) under `o`. */
export function fitScrubSamples(samples: readonly TakeSample[], o: ScrubFitOptions): FittedKey[] {
  return fit(samples, o);
}

function fit(samples: readonly TakeSample[], o: ScrubFitOptions): FittedKey[] {
  const pct = o.captureSpeedPct > 0 ? o.captureSpeedPct : 100;
  const t0 = samples[0]?.t ?? 0;
  const timed = samples.map((s) => ({ t: t0 + (s.t - t0) * (100 / pct), v: s.v }));
  if (!o.smart) {
    return timed.map((s) => ({ t: s.t, value: [...s.v], easing: 'linear' as const, spatialIn: [], spatialOut: [] }))
      .filter((k, i, a) => i === a.length - 1 || Math.abs(a[i + 1]!.t - k.t) > 1e-9);
  }
  return fitTake(timed, {
    frameDuration: o.frameDuration,
    tolerance: detailToTolerance(o.detail, takeRange(timed)),
    holdSeconds: o.holdSeconds,
    wholeFrames: o.wholeFrames,
  });
}

/** The commands that write the fitted `keys` on `prop`: `originals` outside the keys' span kept, the keys inside (see `finishScrub`). */
export function scrubTakeCommands(prop: PropRef, kind: Value['kind'], originals: readonly Keyframe[], keys: readonly FittedKey[]): Command[] {
  return commandsFor(prop, kind, originals, keys);
}

/**
 * The command that stores the take in the document beside its keys (plan
 * §4.1, D5), or null when it cannot be stored (over the sample cap: the keys
 * are still written, and the user is told the take was not kept).
 */
function storeTakeCommand(prop: PropRef, samples: readonly TakeSample[], o: ScrubFitOptions, keys: readonly FittedKey[]): Command | null {
  const take = performanceTakeOf({
    layer: prop.layer,
    path: prop.path,
    source: o.source ?? 'mouse',
    samples,
    fit: scrubFitOf(o),
    keyTimes: keys.map((k) => k.t),
  });
  if (!take && samples.length > MAX_TAKE_SAMPLES) {
    useUIStore.getState().notify({
      level: 'warning',
      durationMs: 4000,
      message: t('performance.takeTooLong', 'The keys were written, but the take itself was not kept: {n} samples is more than 10 minutes at 60 Hz, so Detail cannot re-fit it later', { n: samples.length }),
    });
  }
  return take ? { type: 'setPerformanceTake', take } : null;
}

function commandsFor(prop: PropRef, kind: Value['kind'], originals: readonly Keyframe[], keys: readonly FittedKey[]): Command[] {
  if (keys.length === 0) return [];
  const t0 = compTime(keys[0]!.t);
  const t1 = compTime(keys[keys.length - 1]!.t);
  const kept = originals.filter((k) => k.time < t0 - 1 || k.time > t1 + 1);
  const all = [...kept, ...keys.map((k) => keyOf(kind, k))].sort((a, b) => a.time - b.time);
  return [{ type: 'setKeyframes', prop, keys: all }];
}

/** The last written scrub take, for the Detail control's re-fit. */
interface LastScrub {
  prop: PropRef;
  kind: Value['kind'];
  originals: readonly Keyframe[];
  samples: TakeSample[];
  opts: ScrubFitOptions;
  revision: number;
}

let lastScrub: LastScrub | null = null;

/**
 * Release: fit the take and write it through its gesture (one entry).
 * Resolves to the keys written; a take with no movement writes nothing and
 * its live writes are reverted.
 */
export async function finishScrub(opts: ScrubFitOptions): Promise<number> {
  const s = scrub;
  scrub = null;
  if (!s) return 0;
  const moved = s.samples.some((x) => x.v.some((n, i) => Math.abs(n - (s.start[i] ?? n)) > 1e-9));
  const keys = moved && s.samples.length >= 2 ? fit(s.samples, opts) : [];
  const cmds = commandsFor(s.prop, s.kind, s.originals, keys);
  if (cmds.length === 0) {
    await s.txn.cancel();
    return 0;
  }
  // The raw take rides the same entry as its keys (plan §4.1): one undo for both.
  const store = storeTakeCommand(s.prop, s.samples, opts, keys);
  if (store) cmds.push(store);
  if (s.generation !== engineGeneration()) {
    void s.txn.cancel();
    const res = await edit('Motion Sketch', cmds);
    if (!res.ok) return 0;
  } else {
    s.txn.send('Motion Sketch', cmds, { keep: true });
    await s.txn.end(true);
  }
  await documentMirror().whenIdle();
  lastScrub = { prop: s.prop, kind: s.kind, originals: s.originals, samples: s.samples, opts, revision: documentMirror().revision };
  return keys.length;
}

export function canRefitLastScrub(): boolean {
  return lastScrub !== null && documentMirror().revision === lastScrub.revision;
}

/** Re-fit the last scrub take at another Detail: one entry per adjustment. */
export async function refitLastScrub(detail: number): Promise<number> {
  const last = lastScrub;
  if (!last || !canRefitLastScrub()) return 0;
  const opts = { ...last.opts, detail, smart: true };
  const keys = fit(last.samples, opts);
  const cmds = commandsFor(last.prop, last.kind, last.originals, keys);
  if (cmds.length === 0) return 0;
  const store = storeTakeCommand(last.prop, last.samples, opts, keys);
  if (store) cmds.push(store);
  const res = await edit('Adjust Take Detail', cmds);
  if (!res.ok) return 0;
  await documentMirror().whenIdle();
  lastScrub = { ...last, opts, revision: documentMirror().revision };
  return keys.length;
}
