/**
 * The hand gesture recogniser on synthetic landmark clips: grab / release
 * hysteresis, tap, fist, the relative clutch and gain, lost-hand handling,
 * hand choice — and a jittery clip that measures false-grab resistance.
 */

import type { LiveHand } from '@motion/engine-api';
import {
  DEFAULT_GESTURE_SETTINGS,
  HAND_CONNECTIONS,
  HandGestureRecognizer,
  isFist,
  palmCenter,
  sideOf,
  syntheticHand,
  wristRoll,
  type GestureEvent,
} from './gestures';

const FRAME = { width: 640, height: 360 };
const DT = 1000 / 30;

/** Feed a clip of per-frame hand lists at 30 Hz; returns every event with its frame index. */
function run(rec: HandGestureRecognizer, clip: ReadonlyArray<readonly LiveHand[]>, startMs = 0): Array<GestureEvent & { frame: number }> {
  const out: Array<GestureEvent & { frame: number }> = [];
  clip.forEach((hands, i) => {
    for (const e of rec.feed({ ...FRAME, hands }, startMs + i * DT)) out.push({ ...e, frame: i });
  });
  return out;
}

const types = (events: ReadonlyArray<GestureEvent>): string[] => events.map((e) => e.type);

/** A deterministic pseudo-random sequence (LCG) for jitter — no Math.random in a test. */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000 - 0.5;
  };
}

describe('synthetic hand geometry', () => {
  it('has the palm where asked, the roll it was given, 21 points and a fist when curled', () => {
    const h = syntheticHand({ x: 0.3, y: 0.6, roll: 30 });
    expect(h.landmarks).toHaveLength(63);
    const c = palmCenter(h);
    expect(c.x).toBeCloseTo(0.3, 6);
    expect(c.y).toBeCloseTo(0.6, 6);
    expect(wristRoll(h)).toBeCloseTo(30 - 8.5, 0);
    expect(isFist(h)).toBe(false);
    expect(isFist(syntheticHand({ x: 0.3, y: 0.6, fist: true }))).toBe(true);
    expect(sideOf({ handedness: 0.8 })).toBe('left');
    expect(sideOf({ handedness: 0.2 })).toBe('right');
    expect(HAND_CONNECTIONS).toHaveLength(21);
  });
});

describe('grab and release', () => {
  it('grabs on a confirmed pinch, releases on a confirmed open — with hysteresis between', () => {
    const rec = new HandGestureRecognizer();
    const at = (pinch: number): LiveHand[] => [syntheticHand({ x: 0.5, y: 0.5, pinch })];
    const clip = [
      ...Array(5).fill(at(0.6)),   // open
      ...Array(10).fill(at(0.15)), // pinched
      ...Array(10).fill(at(0.32)), // inside the band: still grabbed
      ...Array(10).fill(at(0.6)),  // open
    ];
    const ev = run(rec, clip);
    expect(types(ev)).toEqual(['grab', 'release']);
    // Second pinched frame (confirmFrames = 2) grabs; second open frame releases.
    expect(ev[0]!.frame).toBe(6);
    expect(ev[1]!.frame).toBe(26);
    expect(rec.control.grabbed).toBe(false);
  });

  it('a single-frame pinch spike is not a grab', () => {
    const rec = new HandGestureRecognizer();
    const clip = [0.6, 0.6, 0.1, 0.6, 0.6, 0.6].map((p) => [syntheticHand({ x: 0.5, y: 0.5, pinch: p })]);
    expect(run(rec, clip)).toEqual([]);
  });

  it('a pinch flickering across the grab threshold every frame never confirms a grab', () => {
    const rec = new HandGestureRecognizer();
    const clip: LiveHand[][] = [];
    for (let i = 0; i < 60; i++) clip.push([syntheticHand({ x: 0.5, y: 0.5, pinch: 0.25 + (i % 2 ? 0.03 : -0.03) })]);
    expect(types(run(rec, clip))).toEqual([]);
    // Once it settles below the threshold it grabs exactly once, and the band keeps it.
    for (let i = 0; i < 60; i++) clip.push([syntheticHand({ x: 0.5, y: 0.5, pinch: 0.15 + (i % 2 ? 0.1 : -0.1) })]);
    for (let i = 0; i < 60; i++) clip.push([syntheticHand({ x: 0.5, y: 0.5, pinch: 0.25 + (i % 2 ? 0.12 : -0.1) })]);
    expect(types(run(new HandGestureRecognizer(), clip))).toEqual(['grab']);
  });
});

describe('false-grab resistance on a jittery clip', () => {
  /**
   * An open hand waving for 20 s at 30 Hz with landmark jitter: the pinch
   * reading wobbles around 0.5 ± 0.12 (worse than the P1.0 spike footage) and
   * the palm shakes by ±1 % of the frame. The default thresholds must not
   * grab even once; the measured number is the test's record.
   */
  it('never grabs while an open hand waves with heavy jitter', () => {
    const rnd = noise(7);
    const rec = new HandGestureRecognizer();
    const clip: LiveHand[][] = [];
    for (let i = 0; i < 600; i++) {
      const x = 0.5 + 0.2 * Math.sin(i / 20) + rnd() * 0.02;
      const y = 0.5 + 0.1 * Math.cos(i / 15) + rnd() * 0.02;
      clip.push([syntheticHand({ x, y, pinch: Math.max(0.05, 0.5 + rnd() * 0.24), roll: rnd() * 20 })]);
    }
    const ev = run(rec, clip);
    const falseGrabs = ev.filter((e) => e.type === 'grab').length;
    expect(falseGrabs).toBe(0);
  });

  it('but the same jitter on a held pinch neither drops the grab nor re-grabs', () => {
    const rnd = noise(11);
    const rec = new HandGestureRecognizer();
    const clip: LiveHand[][] = [];
    for (let i = 0; i < 300; i++) clip.push([syntheticHand({ x: 0.5, y: 0.5, pinch: Math.max(0.02, 0.15 + rnd() * 0.16) })]);
    for (let i = 0; i < 10; i++) clip.push([syntheticHand({ x: 0.5, y: 0.5, pinch: 0.7 })]);
    expect(types(run(rec, clip))).toEqual(['grab', 'release']);
  });
});

describe('tap and fist', () => {
  it('a short, still pinch is a tap (after its grab / release); a long or moving one is not', () => {
    const rec = new HandGestureRecognizer();
    const still = (pinch: number, n: number): LiveHand[][] => Array(n).fill([syntheticHand({ x: 0.5, y: 0.5, pinch })]);
    expect(types(run(rec, [...still(0.6, 3), ...still(0.1, 5), ...still(0.6, 3)]))).toEqual(['grab', 'release', 'tap']);
    // 20 frames pinched = 667 ms > tapMaxMs.
    expect(types(run(rec, [...still(0.1, 20), ...still(0.6, 3)], 10_000))).toEqual(['grab', 'release']);
    // A short pinch that travelled across the frame is a grab, not a tap.
    const moving: LiveHand[][] = [];
    for (let i = 0; i < 5; i++) moving.push([syntheticHand({ x: 0.3 + i * 0.05, y: 0.5, pinch: 0.1 })]);
    expect(types(run(rec, [...still(0.6, 3), ...moving, ...still(0.6, 3)], 20_000))).toEqual(['grab', 'release']);
  });

  it('a fist is reported once on entry and suppresses the pinch grab while it lasts', () => {
    const rec = new HandGestureRecognizer();
    const open = Array(3).fill([syntheticHand({ x: 0.5, y: 0.5, pinch: 0.6 })]);
    // Inside a fist the thumb touches the index: pinch reads small.
    const fist = Array(10).fill([syntheticHand({ x: 0.5, y: 0.5, pinch: 0.08, fist: true })]);
    const ev = run(rec, [...open, ...fist, ...open]);
    expect(types(ev)).toEqual(['fist']);
    expect(rec.control.fist).toBe(false);
  });
});

describe('relative clutch and gain', () => {
  const hand = (x: number, y: number, pinch: number, roll = 0): LiveHand[] => [syntheticHand({ x, y, pinch, roll })];

  it('moves nothing until grabbed; deltas start from the grab and follow the mirror', () => {
    const rec = new HandGestureRecognizer({ gain: 2 });
    run(rec, [hand(0.2, 0.5, 0.6), hand(0.4, 0.5, 0.6), hand(0.6, 0.5, 0.6)]);
    expect(rec.control.grabbed).toBe(false);
    expect(rec.control.dx).toBe(0);
    expect(rec.control.x).toBeCloseTo(0.4, 6); // mirrored: 1 − 0.6
    run(rec, [hand(0.6, 0.5, 0.1), hand(0.6, 0.5, 0.1)], 1000);
    expect(rec.control.grabbed).toBe(true);
    expect(rec.control.dx).toBeCloseTo(0, 9);
    // Camera x falls by 0.1 → on a mirrored screen the hand went right; y down by 0.1 of the frame height.
    run(rec, [hand(0.5, 0.6, 0.1)], 2000);
    expect(rec.control.dx).toBeCloseTo(0.2, 6);         // 0.1 × gain 2
    expect(rec.control.dy).toBeCloseTo(0.1 * (360 / 640) * 2, 6);
    // Release, move elsewhere, re-grab: the new origin is where the hand is now.
    run(rec, [hand(0.5, 0.6, 0.7), hand(0.5, 0.6, 0.7), hand(0.1, 0.1, 0.7), hand(0.1, 0.1, 0.1), hand(0.1, 0.1, 0.1)], 3000);
    expect(rec.control.grabbed).toBe(true);
    expect(rec.control.dx).toBeCloseTo(0, 9);
    expect(rec.control.dy).toBeCloseTo(0, 9);
  });

  it('wrist roll is relative to the grab, continuous across ±180°, and unmirrored when asked', () => {
    const rec = new HandGestureRecognizer({ mirror: false });
    run(rec, [hand(0.5, 0.5, 0.1, 0), hand(0.5, 0.5, 0.1, 0)]);
    expect(rec.control.dRoll).toBe(0);
    // Two full turns in 10° steps: no wrap in the delta.
    const clip: LiveHand[][] = [];
    for (let i = 1; i <= 72; i++) clip.push(hand(0.5, 0.5, 0.1, (i * 10) % 360));
    run(rec, clip, 1000);
    expect(rec.control.dRoll).toBeCloseTo(720, 3);
    const mirrored = new HandGestureRecognizer();
    run(mirrored, [hand(0.5, 0.5, 0.1, 0), hand(0.5, 0.5, 0.1, 0), hand(0.5, 0.5, 0.1, 30)]);
    expect(mirrored.control.dRoll).toBeCloseTo(-30, 3);
  });
});

describe('a lost hand', () => {
  const grabbed = (): HandGestureRecognizer => {
    const rec = new HandGestureRecognizer();
    run(rec, Array(3).fill([syntheticHand({ x: 0.5, y: 0.5, pinch: 0.1 })]));
    expect(rec.control.grabbed).toBe(true);
    return rec;
  };

  it('holds the grab for a short gap and releases it after lostMs', () => {
    const rec = grabbed();
    // 6 empty frames = 200 ms: held.
    expect(run(rec, Array(6).fill([]), 100)).toEqual([]);
    expect(rec.control.grabbed).toBe(true);
    expect(rec.control.present).toBe(false);
    // The hand comes back pinched: still the same grab.
    run(rec, [[syntheticHand({ x: 0.5, y: 0.5, pinch: 0.1 })]], 300);
    expect(rec.control.grabbed).toBe(true);
    // Gone for 400 ms: released and reported lost.
    const ev = run(rec, Array(13).fill([]), 400);
    expect(types(ev)).toEqual(['release', 'lost']);
    expect(rec.control.grabbed).toBe(false);
  });

  it('a low-presence hand counts as no hand', () => {
    const rec = grabbed();
    const faint = [syntheticHand({ x: 0.5, y: 0.5, pinch: 0.1, presence: 0.2 })];
    const ev = run(rec, Array(13).fill(faint), 100);
    expect(types(ev)).toEqual(['release', 'lost']);
  });
});

describe('two hands', () => {
  const left = (x: number, size = 0.12, pinch = 0.6): LiveHand => syntheticHand({ x, y: 0.5, size, pinch, handedness: 0.9 });
  const right = (x: number, size = 0.12, pinch = 0.6): LiveHand => syntheticHand({ x, y: 0.5, size, pinch, handedness: 0.1 });

  it('Either picks the nearer (larger) hand; Left / Right pick that hand', () => {
    const either = new HandGestureRecognizer();
    either.feed({ ...FRAME, hands: [left(0.3, 0.1), right(0.7, 0.2)] }, 0);
    expect(either.control.hand).toBe('right');
    const onlyLeft = new HandGestureRecognizer({ hand: 'left' });
    onlyLeft.feed({ ...FRAME, hands: [left(0.3, 0.1), right(0.7, 0.2)] }, 0);
    expect(onlyLeft.control.hand).toBe('left');
    const onlyRight = new HandGestureRecognizer({ hand: 'right' });
    expect(onlyRight.feed({ ...FRAME, hands: [left(0.3)] }, 0)).toEqual([]);
    expect(onlyRight.control.present).toBe(false);
  });

  it('once grabbed, follows the grabbing hand even when the other comes nearer', () => {
    const rec = new HandGestureRecognizer();
    run(rec, Array(3).fill([right(0.7, 0.12, 0.1)]));
    expect(rec.control.grabbed).toBe(true);
    run(rec, [[left(0.3, 0.3, 0.6), right(0.72, 0.12, 0.1)]], 200);
    expect(rec.control.hand).toBe('right');
    expect(rec.control.grabbed).toBe(true);
    expect(rec.control.dx).toBeCloseTo(-0.02, 6);
  });
});

it('the defaults keep release above grab, and a bad pair is repaired', () => {
  expect(DEFAULT_GESTURE_SETTINGS.releasePinch).toBeGreaterThan(DEFAULT_GESTURE_SETTINGS.grabPinch);
  const rec = new HandGestureRecognizer({ grabPinch: 0.3, releasePinch: 0.2 });
  expect(rec.settings.releasePinch).toBeGreaterThan(rec.settings.grabPinch);
});
