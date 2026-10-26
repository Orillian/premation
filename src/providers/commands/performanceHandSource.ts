/**
 * The Performance bar's HAND source (docs/PERFORMANCE_ANIMATION_PLAN.md P1.3):
 * a tracked hand drives the same take pipeline the mouse does.
 *
 *   camera → engine live input → LiveFrame (core/live/liveInput)
 *     → HandGestureRecognizer (core/live/gestures): grab / release / tap /
 *       fist events + a continuous control (clutch deltas, wrist roll, pinch)
 *     → THIS module maps the control onto the armed take:
 *         Position  ← hand x / y   (clutch deltas × gain, in comp px)
 *         Rotation  ← wrist roll   (degrees, continuous)
 *         Scale /   ← pinch distance (relative to the pinch when the take
 *         Opacity      started, clamped to the property's range)
 *     → Motion Sketch (Position) or the scrub recorder (the rest), exactly as
 *       the pointer feeds them: live writes through the take's ONE gesture,
 *       one `setKeyframes` per track at the end, Esc reverts.
 *
 * What starts and ends a take is the session's decision (performanceSession
 * reacts to the events this module hands it); this module owns the camera
 * subscription, the recogniser, and the value mapping while a take is bound.
 *
 * Latency: each frame says how old it is (sensor → landmarks); a sample is
 * stamped that much earlier than the clock, or every take would feel late
 * (plan §3.3 / §8.5).
 *
 * Editor state only: nothing here is in the document.
 */

import type { Command, PropRef, Value } from '@motion/engine-api';
import { Matrix } from '@motion/scene';
import { HandGestureRecognizer, type GestureEvent, type HandControl } from '@core/live/gestures';
import { onLiveFrame, startLiveInput, stopLiveInput, type LiveFrame } from '@core/live/liveInput';
import { motionSketchTransaction, recordMotionSketchSample } from '@core/animation/motionSketch';
import { engine } from '@core/engine/engineInstance';
import { compTime, values } from '@core/engine/propRefs';
import { numbersOfValue } from '@core/mirror/trackIndex';
import { documentMirror } from '@stores/documentMirror';
import type { PerformanceTarget } from '@stores/performanceStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { trackRef } from '@layout/Inspector/inspectorEdits';
import { moveScrubBy, scrubActive } from './performanceScrub';

/**
 * Percent of Scale / Opacity per unit of pinch (thumb tip → index tip over the
 * palm): a pinch opening from touching (≈ 0.1) to a relaxed hand (≈ 0.6) is a
 * 100 % swing at gain 1.
 */
export const PINCH_SPAN = 200;

/** Targets a pinch GRABS (the take runs while the hand is closed) vs. targets the pinch DRIVES. */
export function grabDriven(target: PerformanceTarget): boolean {
  return target === 'position' || target === 'rotation';
}

export interface HandSourceHost {
  /** The playhead now, comp seconds (the transient clock). */
  now: () => number;
  /** Milliseconds for the recogniser's timers (tap length, lost hand). */
  clockMs?: () => number;
  onEvent: (e: GestureEvent) => void;
}

/** What the overlay and the bar read per frame (no React render; polled from a frame listener). */
export interface HandSourceState {
  on: boolean;
  present: boolean;
  grabbed: boolean;
  fist: boolean;
  recording: boolean;
  hand: HandControl['hand'];
}

const state: HandSourceState = { on: false, present: false, grabbed: false, fist: false, recording: false, hand: 'right' };

let host: HandSourceHost | null = null;
let recognizer: HandGestureRecognizer | null = null;
let unsubscribe: (() => void) | null = null;

const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function recognizerFromPrefs(): HandGestureRecognizer {
  const p = usePreferenceStore.getState();
  return new HandGestureRecognizer({ hand: p.performanceHand, mirror: p.performanceHandMirror, gain: p.performanceHandGain });
}

/** The live state, for the overlay (the object is stable; read fields). */
export function handSourceState(): Readonly<HandSourceState> {
  return state;
}

/** The recogniser's control after the last frame (null while the source is off). */
export function handControl(): Readonly<HandControl> | null {
  return recognizer?.control ?? null;
}

/**
 * Turn the hand source on: start the camera (its outcome arrives as status in
 * liveInputStore) and follow every frame. Resolves to the refusal when the
 * engine cannot even try (not the desktop app), else null.
 */
export async function startHandSource(h: HandSourceHost): Promise<string | null> {
  stopHandSource(false);
  host = h;
  recognizer = recognizerFromPrefs();
  state.on = true;
  unsubscribe = onLiveFrame(onFrame);
  return startLiveInput();
}

/** Turn it off: forget the take binding, stop following frames, release the camera. */
export function stopHandSource(releaseCamera = true): void {
  unsubscribe?.();
  unsubscribe = null;
  host = null;
  recognizer = null;
  binding = null;
  state.on = state.present = state.grabbed = state.fist = state.recording = false;
  if (releaseCamera) void stopLiveInput();
}

export function handSourceOn(): boolean {
  return state.on;
}

/** The settings changed (gain, hand, mirror): a fresh recogniser, the camera untouched. */
export function refreshHandSettings(): void {
  if (!state.on) return;
  recognizer = recognizerFromPrefs();
}

// ── The take binding: control → property ─────────────────────────────────────

interface PositionBinding {
  kind: 'position';
  nodeId: string;
  /** The Position property (one vector prop, or separated X / Y scalars). */
  rx: PropRef;
  ry: PropRef;
  separated: boolean;
  valueKind: Value['kind'];
  /** The value at the take's start, API numbers. */
  start: number[];
  /** Comp px per frame-width unit of hand travel (the comp's width). */
  pxPerUnit: number;
  /**
   * World → the parent's space (the linear part): a hand's travel is a WORLD
   * delta, a layer's x / y are PARENT-space values — the same conversion the
   * pointer's move makes (ports.ts movedValues), through the same matrix, or a
   * child of a scaled / turned null travels the wrong distance. Null when
   * unparented.
   */
  inv: { a: number; b: number; c: number; d: number } | null;
}

interface ScrubBinding {
  kind: 'scrub';
  target: Exclude<PerformanceTarget, 'position'>;
  /** Pinch when the take started: the clutch origin for pinch-driven targets. */
  pinch0: number;
  gain: number;
}

type Binding = PositionBinding | ScrubBinding;

let binding: Binding | null = null;

/**
 * Bind the running take on `nodeId`'s Position to the hand: reads the value at
 * `t` (what the clutch deltas add to). Position's live writes go through
 * Motion Sketch's gesture (it must be armed). Resolves false when Position
 * cannot be addressed.
 */
export async function bindHandPosition(nodeId: string, t: number, compWidth: number): Promise<boolean> {
  const rx = trackRef(nodeId, 'x');
  const ry = trackRef(nodeId, 'y');
  if (!rx || !ry) return false;
  // One round trip: the values and, under a parent, the parent's world affine
  // at the take's start (the space the layer's own x / y live in, read from the
  // engine as the pointer's Move reads it): a world delta goes through its
  // inverse. The grab's first frames arrive while this is in flight.
  const parent = documentMirror().layer(nodeId)?.parent;
  const [res, xf] = await Promise.all([
    engine().query({ type: 'getPropertyValues', props: [rx.ref, ry.ref], time: compTime(t), evaluated: true }),
    parent ? engine().query({ type: 'getLayerTransforms', layers: [parent], time: compTime(t) }) : Promise.resolve(null),
  ]);
  if (!res.ok) return false;
  const vx = res.value.values[0]?.value;
  const vy = res.value.values[1]?.value;
  if (!vx || !vy) return false;
  const separated = rx.ref.path !== ry.ref.path;
  const start = separated ? [numbersOfValue(vx)[0] ?? 0, numbersOfValue(vy)[0] ?? 0] : numbersOfValue(vx);
  let inv: PositionBinding['inv'] = null;
  // Column-major 4x4 layer -> comp; the 2D linear part is what a delta needs.
  const m4 = xf?.ok ? xf.value.transforms[0]?.matrix : undefined;
  if (m4 && m4.length === 16) {
    const m = Matrix.invert({ a: m4[0]!, b: m4[1]!, c: m4[4]!, d: m4[5]!, e: m4[12]!, f: m4[13]! });
    inv = { a: m.a, b: m.b, c: m.c, d: m.d };
  }
  binding = { kind: 'position', nodeId, rx: rx.ref, ry: ry.ref, separated, valueKind: vx.kind, start, pxPerUnit: compWidth > 0 ? compWidth : 1920, inv };
  state.recording = true;
  return true;
}

/** Bind the running scrub take (performanceScrub.beginScrub was called) to the hand. */
export function bindHandScrub(target: Exclude<PerformanceTarget, 'position'>): void {
  const c = recognizer?.control;
  binding = { kind: 'scrub', target, pinch0: c?.pinch ?? 0.5, gain: usePreferenceStore.getState().performanceHandGain };
  state.recording = true;
}

/** The take ended (written, cancelled, or the bar closed): the hand drives nothing until the next bind. */
export function unbindHand(): void {
  binding = null;
  state.recording = false;
}

export function handBound(): boolean {
  return binding !== null;
}

function positionValue(b: PositionBinding, x: number, y: number): Command[] {
  if (b.separated) {
    return [
      { type: 'setProperty', prop: b.rx, value: values.scalar(x), time: 0 },
      { type: 'setProperty', prop: b.ry, value: values.scalar(y), time: 0 },
    ];
  }
  const v = b.valueKind === 'vec3' ? values.vec3(x, y, b.start[2] ?? 0) : values.vec2(x, y);
  return [{ type: 'setProperty', prop: b.rx, value: v, time: 0 }];
}

/** Apply the control to the bound take at comp time `t` (exported for the tests). */
export function applyHandControl(c: Readonly<HandControl>, t: number): void {
  const b = binding;
  if (!b) return;
  if (b.kind === 'position') {
    if (!c.grabbed) return;
    // The hand's travel in comp (world) px, then into the parent's space.
    let wx = c.dx * b.pxPerUnit;
    let wy = c.dy * b.pxPerUnit;
    if (b.inv) [wx, wy] = [b.inv.a * wx + b.inv.c * wy, b.inv.b * wx + b.inv.d * wy];
    const x = (b.start[0] ?? 0) + wx;
    const y = (b.start[1] ?? 0) + wy;
    recordMotionSketchSample(b.nodeId, x, y, t);
    const txn = motionSketchTransaction();
    if (txn) txn.send('Motion Sketch', positionValue(b, x, y).map((cmd) => ({ ...cmd, time: compTime(t) })));
    return;
  }
  if (!scrubActive()) return;
  if (b.target === 'rotation') {
    if (!c.grabbed) return;
    moveScrubBy(c.dRoll, t);
    return;
  }
  // Scale / Opacity: the pinch, from where it was when the take started.
  moveScrubBy((c.pinch - b.pinch0) * PINCH_SPAN * b.gain, t);
}

function onFrame(frame: LiveFrame): void {
  const rec = recognizer;
  const h = host;
  if (!rec || !h) return;
  const events = rec.feed(frame, (h.clockMs ?? nowMs)());
  const c = rec.control;
  state.present = c.present;
  state.grabbed = c.grabbed;
  state.fist = c.fist;
  state.hand = c.hand;
  for (const e of events) {
    try {
      h.onEvent(e);
    } catch {
      // The session's bug must not stop the stream.
    }
  }
  if (!binding || !c.present) return;
  // The frame is `latencyMs` old: the sample belongs that much earlier. (Samples
  // before the take's start — the pre-roll — are the recorders' to drop.)
  const t = Math.max(0, h.now() - (frame.latencyMs > 0 ? frame.latencyMs / 1000 : 0));
  applyHandControl(c, t);
}
