/**
 * Hand gestures from live landmarks (docs/PERFORMANCE_ANIMATION_PLAN.md P1.2).
 *
 * A `LiveFrame` carries up to two hands as 21 MediaPipe landmarks each. This
 * module turns that stream into the few things the performance pipeline
 * needs — pure and deterministic (no clock, no randomness: the caller stamps
 * every frame), so it is unit-tested with synthetic landmark clips.
 *
 *   * **Grab / release** — the pinch (thumb tip to index tip over the palm's
 *     size, `LiveHand.pinch`) closing and opening, with HYSTERESIS: the grab
 *     threshold is tighter than the release threshold, and each edge must hold
 *     for `confirmFrames` frames, so landmark jitter around either threshold
 *     cannot flicker the grab. A grab is what a mouse press is to Motion Sketch.
 *   * **Tap** — a short pinch during which the hand stayed still: Pose mode's
 *     Set Key (plan §2.2). Reported on the release, after the grab / release
 *     pair, so Perform mode can simply ignore it.
 *   * **Fist** — all four fingertips curled toward the wrist (each tip closer
 *     to the wrist than its own PIP joint). The other "set" gesture of Pose
 *     mode. While the hand is a fist the pinch is NOT read as a grab: thumb
 *     and index tip touch inside a fist too.
 *   * **Relative clutch** — while not grabbed the hand's motion moves nothing;
 *     on grab the hand's position (and wrist roll) becomes the origin and the
 *     control reports deltas from it, scaled by `gain` (plan §2.1). Lifting the
 *     mouse, for hands.
 *   * **Lost hand** — no hand (or a low-presence one) for less than `lostMs`
 *     holds the last control; for `lostMs` or longer releases the grab, as if
 *     the pinch had opened (plan §8.5).
 *
 * Two hands, one mapping (plan §8.5): the setting picks the performer's Left /
 * Right / Either; with Either the nearer (larger on camera) hand drives, and
 * once grabbed the recogniser follows the hand it grabbed with. Mirror is on by
 * default: the camera sees the performer, so moving right must move right on
 * screen.
 *
 * Units: positions are normalised to the camera frame's WIDTH on both axes
 * (y is scaled by height / width), so a physical circle stays a circle and
 * the same movement means the same thing on a 16:9 and a 4:3 camera. Wrist
 * roll is degrees, continuous (two turns stay two turns, plan §8.1).
 */

import type { LiveHand } from '@motion/engine-api';
import type { LiveFrame } from './liveInput';

// ── Landmarks ─────────────────────────────────────────────────────────────────

/** MediaPipe hand landmark indices used here. */
export const LM = {
  wrist: 0,
  thumbTip: 4,
  indexMcp: 5,
  indexPip: 6,
  indexTip: 8,
  middleMcp: 9,
  middlePip: 10,
  middleTip: 12,
  ringMcp: 13,
  ringPip: 14,
  ringTip: 16,
  pinkyMcp: 17,
  pinkyPip: 18,
  pinkyTip: 20,
} as const;

/** The 21-point skeleton's bones, as landmark index pairs (for the overlay). */
export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export interface Point2 {
  x: number;
  y: number;
}

/** Landmark `i` of `hand` as x / y (frame-normalised, as delivered). */
export function landmark(hand: Pick<LiveHand, 'landmarks'>, i: number): Point2 {
  return { x: hand.landmarks[i * 3] ?? 0, y: hand.landmarks[i * 3 + 1] ?? 0 };
}

const dist = (a: Point2, b: Point2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** The palm's size: wrist → middle finger base. The scale every threshold is relative to. */
export function palmSize(hand: Pick<LiveHand, 'landmarks'>): number {
  return dist(landmark(hand, LM.wrist), landmark(hand, LM.middleMcp));
}

/**
 * Where the hand IS: the palm's centre (the mean of the wrist and the four
 * finger bases). Fingers move while pinching; the palm does not, so a grab
 * does not nudge the target.
 */
export function palmCenter(hand: Pick<LiveHand, 'landmarks'>): Point2 {
  const pts = [LM.wrist, LM.indexMcp, LM.middleMcp, LM.ringMcp, LM.pinkyMcp].map((i) => landmark(hand, i));
  return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
}

/**
 * The wrist's roll in the image plane, degrees in (−180, 180]: the angle of
 * wrist → middle finger base, 0 when the fingers point straight up on camera,
 * positive clockwise on screen.
 */
export function wristRoll(hand: Pick<LiveHand, 'landmarks'>): number {
  const w = landmark(hand, LM.wrist);
  const m = landmark(hand, LM.middleMcp);
  return (Math.atan2(m.x - w.x, -(m.y - w.y)) * 180) / Math.PI;
}

/**
 * A fist: each of the four fingers' tips closer to the wrist than its PIP
 * joint — the finger is folded over itself. Independent of hand size and
 * camera distance, and false for an open or pointing hand.
 */
export function isFist(hand: Pick<LiveHand, 'landmarks'>): boolean {
  const w = landmark(hand, LM.wrist);
  const fingers: ReadonlyArray<readonly [number, number]> = [
    [LM.indexTip, LM.indexPip],
    [LM.middleTip, LM.middlePip],
    [LM.ringTip, LM.ringPip],
    [LM.pinkyTip, LM.pinkyPip],
  ];
  return fingers.every(([tip, pip]) => dist(landmark(hand, tip), w) < dist(landmark(hand, pip), w));
}

export type HandSide = 'left' | 'right';

/** The performer's hand: the model's handedness is given for a mirrored view (engine-api LiveHand). */
export function sideOf(hand: Pick<LiveHand, 'handedness'>): HandSide {
  return hand.handedness > 0.5 ? 'left' : 'right';
}

// ── Settings ──────────────────────────────────────────────────────────────────

export interface GestureSettings {
  /** Pinch at or below this grabs (LiveHand.pinch units: ~0.1 touching, ≥ 0.5 open). */
  grabPinch: number;
  /** Pinch at or above this releases. Must be above `grabPinch` (the hysteresis band). */
  releasePinch: number;
  /** Consecutive frames an edge must hold before it counts. */
  confirmFrames: number;
  /** A grab shorter than this (ms) that did not move is a tap. */
  tapMaxMs: number;
  /** Largest palm movement (frame-width units) during a pinch that still counts as a tap. */
  tapMaxMove: number;
  /** No (confident) hand for this long releases the grab, ms. */
  lostMs: number;
  /** Below this presence a hand is not trusted: the control holds (plan §8.5 low confidence). */
  minPresence: number;
  /** Which of the performer's hands drives. */
  hand: HandSide | 'either';
  /** Moving right on camera moves right on screen. */
  mirror: boolean;
  /** Clutch deltas are multiplied by this (1 = a full frame width of hand travel is one unit). */
  gain: number;
}

/**
 * Chosen on the hand model's pinch scale (thumb tip → index tip over the
 * palm): a touching pinch reads ≈ 0.1, a relaxed open hand ≥ 0.5. Grab at
 * 0.25 asks for a deliberate near-touch; release at 0.40 is a clear opening.
 * The 0.15 band is about five times the frame-to-frame jitter of a steady
 * pinch on the P1.0 spike footage, and two confirming frames (66 ms at 30 Hz)
 * swallow single-frame landmark spikes without a felt delay.
 */
export const DEFAULT_GESTURE_SETTINGS: GestureSettings = {
  grabPinch: 0.25,
  releasePinch: 0.4,
  confirmFrames: 2,
  tapMaxMs: 300,
  tapMaxMove: 0.04,
  lostMs: 300,
  minPresence: 0.5,
  hand: 'either',
  mirror: true,
  gain: 1,
};

// ── Output ────────────────────────────────────────────────────────────────────

export type GestureEvent =
  | { type: 'grab'; tMs: number }
  | { type: 'release'; tMs: number }
  | { type: 'tap'; tMs: number }
  | { type: 'fist'; tMs: number }
  | { type: 'lost'; tMs: number };

/** The continuous control the mapping reads, in normalised units. */
export interface HandControl {
  /** A trusted hand was seen this frame (false = the values are held). */
  present: boolean;
  grabbed: boolean;
  fist: boolean;
  hand: HandSide;
  /** Palm centre, frame-width units, mirror applied (x grows to the right on screen). */
  x: number;
  y: number;
  /** Clutch delta since the grab × gain; 0 while not grabbed. */
  dx: number;
  dy: number;
  /** Wrist roll, degrees, continuous; `dRoll` since the grab, 0 while not grabbed. */
  roll: number;
  dRoll: number;
  /** Thumb tip → index tip over the palm (LiveHand.pinch). */
  pinch: number;
  /** Pinch at the grab (the clutch origin for pinch-driven targets). */
  pinch0: number;
}

const emptyControl = (): HandControl => ({
  present: false, grabbed: false, fist: false, hand: 'right',
  x: 0.5, y: 0.5, dx: 0, dy: 0, roll: 0, dRoll: 0, pinch: 1, pinch0: 1,
});

// ── The recogniser ────────────────────────────────────────────────────────────

/**
 * Feed it every `LiveFrame` with the frame's time; read `control` after each
 * feed and act on the events it returns.
 */
export class HandGestureRecognizer {
  readonly settings: GestureSettings;
  readonly control: HandControl = emptyControl();

  /** Frames in a row the pinch has been at or below grab / at or above release. */
  private closedRun = 0;
  private openRun = 0;
  private fistRun = 0;
  private fisted = false;
  private grabAtMs = 0;
  /** Palm position at the grab (unmirrored frame-width units) and the farthest it got since. */
  private origin: Point2 = { x: 0, y: 0 };
  private originRoll = 0;
  private travel = 0;
  /** Last time a trusted hand was seen (−∞ before the first). */
  private seenAtMs = -Infinity;
  private lostReported = true;
  /** Unwrapped roll bookkeeping: the previous raw angle and the turns accumulated. */
  private prevRawRoll: number | null = null;
  private rollTurns = 0;
  /** Where the hand was last (unmirrored), to follow the same hand across frames. */
  private lastPalm: Point2 | null = null;
  private lastSide: HandSide | null = null;

  constructor(settings: Partial<GestureSettings> = {}) {
    this.settings = { ...DEFAULT_GESTURE_SETTINGS, ...settings };
    if (this.settings.releasePinch <= this.settings.grabPinch) this.settings.releasePinch = this.settings.grabPinch + 0.05;
    if (this.settings.confirmFrames < 1) this.settings.confirmFrames = 1;
  }

  /** Forget everything (a new take source, a new camera). */
  reset(): void {
    Object.assign(this.control, emptyControl());
    this.closedRun = this.openRun = this.fistRun = 0;
    this.fisted = false;
    this.travel = 0;
    this.seenAtMs = -Infinity;
    this.lostReported = true;
    this.prevRawRoll = null;
    this.rollTurns = 0;
    this.lastPalm = null;
    this.lastSide = null;
  }

  /** The hand this frame drives with, or null. */
  pick(hands: readonly LiveHand[]): LiveHand | null {
    const s = this.settings;
    const ok = hands.filter((h) => h.presence >= s.minPresence && h.landmarks.length >= 63 && (s.hand === 'either' || sideOf(h) === s.hand));
    if (ok.length === 0) return null;
    if (ok.length === 1) return ok[0]!;
    // Grabbed (or just seen): stay with the hand we were following — nearest to where it was.
    if (this.lastPalm && (this.control.grabbed || this.lastSide)) {
      const last = this.lastPalm;
      const side = this.lastSide;
      let best: LiveHand | null = null;
      let bestD = Infinity;
      for (const h of ok) {
        const d = dist(palmCenter(h), last) + (side && sideOf(h) !== side ? 0.5 : 0);
        if (d < bestD) {
          bestD = d;
          best = h;
        }
      }
      if (best && (this.control.grabbed || bestD < 0.15)) return best;
    }
    // Otherwise the nearer hand: the larger one on camera.
    return ok.reduce((a, b) => (palmSize(b) > palmSize(a) ? b : a));
  }

  /** One frame at `tMs` (any monotonic ms clock). Returns the events it caused, in order. */
  feed(frame: Pick<LiveFrame, 'hands' | 'width' | 'height'>, tMs: number): GestureEvent[] {
    const s = this.settings;
    const c = this.control;
    const events: GestureEvent[] = [];
    const hand = this.pick(frame.hands);

    if (!hand) {
      c.present = false;
      if (c.grabbed && this.seenAtMs !== -Infinity && tMs - this.seenAtMs >= s.lostMs) {
        this.release(events, tMs, false);
      }
      if (!this.lostReported && this.seenAtMs !== -Infinity && tMs - this.seenAtMs >= s.lostMs) {
        this.lostReported = true;
        this.closedRun = this.openRun = this.fistRun = 0;
        this.fisted = false;
        c.fist = false;
        this.prevRawRoll = null;
        this.lastPalm = null;
        this.lastSide = null;
        events.push({ type: 'lost', tMs });
      }
      return events;
    }

    this.seenAtMs = tMs;
    this.lostReported = false;
    c.present = true;
    c.hand = sideOf(hand);
    this.lastSide = c.hand;

    // Geometry, in frame-width units; y scaled so a physical circle stays a circle.
    const aspect = frame.width > 0 && frame.height > 0 ? frame.height / frame.width : 9 / 16;
    const palm = palmCenter(hand);
    const p: Point2 = { x: palm.x, y: palm.y * aspect };
    this.lastPalm = palm;
    const rawRoll = wristRoll(hand);
    if (this.prevRawRoll !== null) {
      const d = rawRoll - this.prevRawRoll;
      if (d > 180) this.rollTurns -= 1;
      else if (d < -180) this.rollTurns += 1;
    }
    this.prevRawRoll = rawRoll;
    const roll = (rawRoll + this.rollTurns * 360) * (s.mirror ? -1 : 1);

    c.x = s.mirror ? 1 - p.x : p.x;
    c.y = p.y;
    c.roll = roll;
    c.pinch = hand.pinch;

    // Fist first: it owns the pinch reading while it lasts.
    const fistNow = isFist(hand);
    this.fistRun = fistNow ? this.fistRun + 1 : 0;
    if (!this.fisted && this.fistRun >= s.confirmFrames) {
      this.fisted = true;
      c.fist = true;
      if (c.grabbed) this.release(events, tMs, false);
      events.push({ type: 'fist', tMs });
    } else if (this.fisted && !fistNow) {
      this.fisted = false;
      c.fist = false;
    }

    // Pinch edges with hysteresis and confirmation.
    const closed = hand.pinch <= s.grabPinch;
    const open = hand.pinch >= s.releasePinch;
    this.closedRun = closed ? this.closedRun + 1 : 0;
    this.openRun = open ? this.openRun + 1 : 0;
    if (!c.grabbed && !this.fisted && this.closedRun >= s.confirmFrames) {
      c.grabbed = true;
      this.grabAtMs = tMs;
      this.origin = { ...p };
      this.originRoll = roll;
      this.travel = 0;
      c.pinch0 = hand.pinch;
      c.dx = c.dy = c.dRoll = 0;
      events.push({ type: 'grab', tMs });
    } else if (c.grabbed && this.openRun >= s.confirmFrames) {
      this.release(events, tMs, true);
    }

    if (c.grabbed) {
      const dx = (p.x - this.origin.x) * (s.mirror ? -1 : 1);
      const dy = p.y - this.origin.y;
      this.travel = Math.max(this.travel, Math.hypot(p.x - this.origin.x, dy));
      c.dx = dx * s.gain;
      c.dy = dy * s.gain;
      c.dRoll = roll - this.originRoll;
    } else {
      c.dx = c.dy = c.dRoll = 0;
    }
    return events;
  }

  /** The grab ends: a release, and a tap when it was short and still (`mayTap`). */
  private release(events: GestureEvent[], tMs: number, mayTap: boolean): void {
    const c = this.control;
    c.grabbed = false;
    c.dx = c.dy = c.dRoll = 0;
    this.closedRun = 0;
    events.push({ type: 'release', tMs });
    if (mayTap && tMs - this.grabAtMs <= this.settings.tapMaxMs && this.travel <= this.settings.tapMaxMove) {
      events.push({ type: 'tap', tMs });
    }
  }
}

// ── Synthetic hands (tests, and the Settings camera test's preview) ───────────

/**
 * A plausible hand from a few numbers: palm centre (frame-normalised), palm
 * size, `pinch` (thumb tip → index tip over the palm), `roll` degrees and
 * whether the fingers are curled. Enough geometry that every reader above
 * (palm centre, roll, fist, pinch) agrees with the parameters.
 */
export function syntheticHand(o: {
  x: number;
  y: number;
  size?: number;
  pinch?: number;
  roll?: number;
  fist?: boolean;
  handedness?: number;
  presence?: number;
}): LiveHand {
  const size = o.size ?? 0.12;
  const pinch = o.pinch ?? 0.6;
  const rollRad = ((o.roll ?? 0) * Math.PI) / 180;
  // Up-vector (toward the fingers) and right-vector in the image, rotated by the roll.
  const up = { x: Math.sin(rollRad), y: -Math.cos(rollRad) };
  const right = { x: Math.cos(rollRad), y: Math.sin(rollRad) };
  const at = (u: number, r: number): Point2 => ({ x: o.x + up.x * u * size + right.x * r * size, y: o.y + up.y * u * size + right.y * r * size });
  // The palm centre is the mean of the wrist and the four MCPs: wrist at −0.6, MCPs at +0.4 (mean 0.2 → shift so the mean is 0).
  const wrist = at(-0.8, 0);
  const mcp = (r: number): Point2 => at(0.2, r);
  const pts: Point2[] = new Array(21).fill(null).map(() => ({ x: 0, y: 0 }));
  pts[0] = wrist;
  pts[5] = mcp(-0.45);
  pts[9] = mcp(-0.15);
  pts[13] = mcp(0.15);
  pts[17] = mcp(0.45);
  const finger = (base: number, r: number, curled: boolean): void => {
    // PIP, DIP, tip up the finger; a curled finger folds its tip back below its PIP.
    pts[base + 1] = at(0.7, r);
    pts[base + 2] = curled ? at(0.6, r) : at(1.05, r);
    pts[base + 3] = curled ? at(0.1, r) : at(1.35, r);
  };
  finger(5, -0.45, o.fist ?? false);
  finger(9, -0.15, o.fist ?? false);
  finger(13, 0.15, o.fist ?? false);
  finger(17, 0.45, o.fist ?? false);
  // Thumb: from the wrist out to the side; its tip sits `pinch` palm-sizes from the index tip.
  pts[1] = at(-0.5, -0.6);
  pts[2] = at(-0.1, -0.85);
  pts[3] = at(0.35, -0.9);
  const indexTip = pts[8]!;
  pts[4] = { x: indexTip.x - right.x * pinch * size, y: indexTip.y - right.y * pinch * size };
  const landmarks: number[] = [];
  for (const p of pts) landmarks.push(p.x, p.y, 0);
  return { landmarks, handedness: o.handedness ?? 0.2, presence: o.presence ?? 0.95, pinch };
}
