/**
 * What the keyframe selection bar says about the selection, as pure functions
 * (the bar renders them; the tests pin them).
 *
 * ## Which ease is "on"
 *
 * Easy Ease is applied to a key's SIDES, as After Effects does it (see
 * `easeSidesOnKeys`): the key's departure lives on its own handles (x1, y1)
 * and its arrival on the PREVIOUS key's (x2, y2). So "is this key eased in?"
 * is a question about its neighbour, and a bar that only read the key's own
 * curve would light "Ease" for a key whose arrival is linear. A side that does
 * not exist (the first key has no arrival, the last no departure) never
 * disagrees with anything.
 */

import type { CubicBezier, Keyframe } from '@motion/engine-api';

export type BarEase = 'Ease' | 'EaseIn' | 'EaseOut' | 'Linear' | 'Hold';

/** One side of a key: Easy-eased, straight, something else, or absent (null). */
export type Side = 'ease' | 'linear' | 'other' | null;

export interface KeyEaseFacts {
  hold: boolean;
  /** On the previous key's handles (x2, y2). Null: no arrival (the first key, or after a hold). */
  arrival: Side;
  /** On this key's handles (x1, y1). Null: no departure (the last key). */
  departure: Side;
}

const EPS = 1e-4;
const near = (a: number, b: number): boolean => Math.abs(a - b) < EPS;
const isHold = (e: Keyframe['easing'] | undefined): boolean => e === 'hold' || e === 'step';
const isBezier = (k: Keyframe): k is Keyframe & { bezier: CubicBezier } => k.easing === 'bezier' && !!k.bezier;

/** A handle on the diagonal is straight (constant speed); (1/3, 0) / (2/3, 1) is Easy Ease. */
function sideOf(k: Keyframe, x: number, y: number, easeY: number): Side {
  if (k.easing === 'linear') return 'linear';
  if (!isBezier(k)) return 'other';
  if (near(y, easeY) && near(x, easeY === 0 ? 1 / 3 : 2 / 3)) return 'ease';
  return near(x, y) ? 'linear' : 'other';
}

export function keyEaseFacts(prev: Keyframe | undefined, key: Keyframe, next: Keyframe | undefined): KeyEaseFacts {
  const hold = isHold(key.easing);
  const departure: Side = next === undefined || hold ? null : sideOf(key, key.bezier?.x1 ?? 0, key.bezier?.y1 ?? 0, 0);
  const arrival: Side = prev === undefined || isHold(prev.easing) ? null : sideOf(prev, prev.bezier?.x2 ?? 0, prev.bezier?.y2 ?? 0, 1);
  return { hold, arrival, departure };
}

/** Every side that exists is `want`. */
const all = (f: KeyEaseFacts, want: Side): boolean => (f.arrival === null || f.arrival === want) && (f.departure === null || f.departure === want);

/**
 * The one ease every selected key has, or null when they differ (or nothing
 * is selected). A lone key with neither side (a property with one key) has no
 * ease to show.
 */
export function activeEase(facts: ReadonlyArray<KeyEaseFacts>): BarEase | null {
  if (facts.length === 0) return null;
  if (facts.every((f) => f.hold)) return 'Hold';
  if (facts.some((f) => f.hold)) return null;
  if (facts.every((f) => f.arrival === null && f.departure === null)) return null;
  if (facts.every((f) => all(f, 'ease'))) return 'Ease';
  // In and Out need their side to EXIST on every key: Ease In on a first key
  // is a no-op, so lighting "In" for it would claim an ease that is not there.
  if (facts.every((f) => f.arrival === 'ease' && f.departure !== 'ease')) return 'EaseIn';
  if (facts.every((f) => f.departure === 'ease' && f.arrival !== 'ease')) return 'EaseOut';
  if (facts.every((f) => all(f, 'linear'))) return 'Linear';
  return null;
}

/**
 * How many keys a move would land ON — keys of the same property, not in the
 * move, at a moved key's new time. The engine replaces them (as dragging a key
 * onto another does), so the bar says so instead of losing them silently.
 */
export function landingCollisions(
  groups: ReadonlyArray<{ moving: readonly number[]; others: readonly number[] }>,
  delta: number,
  tolerance: number,
): number {
  let hits = 0;
  for (const g of groups) {
    const others = new Set<number>();
    for (const t of g.moving) {
      const to = t + delta;
      g.others.forEach((o, i) => { if (Math.abs(o - to) <= tolerance) others.add(i); });
    }
    hits += others.size;
  }
  return hits;
}

/**
 * Arrow-key movement in the bar (the WAI-ARIA toolbar pattern): Left/Right
 * step over disabled buttons and wrap; Home/End go to the ends. -1: not a
 * movement key, or nothing enabled.
 */
export function toolbarStep(current: number, key: string, enabled: ReadonlyArray<boolean>): number {
  const n = enabled.length;
  const live = enabled.map((e, i) => (e ? i : -1)).filter((i) => i >= 0);
  if (live.length === 0) return -1;
  switch (key) {
    case 'Home': return live[0]!;
    case 'End': return live[live.length - 1]!;
    case 'ArrowRight':
    case 'ArrowLeft': {
      const dir = key === 'ArrowRight' ? 1 : -1;
      for (let s = 1; s <= n; s++) {
        const i = (((current + dir * s) % n) + n) % n;
        if (enabled[i]) return i;
      }
      return -1;
    }
    default:
      return -1;
  }
}
