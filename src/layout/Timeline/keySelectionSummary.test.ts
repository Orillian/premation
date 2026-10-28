/**
 * What the selection bar lights up, and how it moves focus and counts
 * collisions. The ease answers are the ones that go silently wrong: a key's
 * ARRIVAL ease lives on the previous key (`easeSidesOnKeys`), so a bar that
 * read only the key's own curve would claim "Easy Ease" for a key whose
 * arrival is linear — and the user would trust the lit button.
 */

import type { Keyframe } from '@motion/engine-api';
import { activeEase, keyEaseFacts, landingCollisions, toolbarStep, type Side } from './keySelectionSummary';

const EASE = { x1: 1 / 3, y1: 0, x2: 2 / 3, y2: 1 };
const key = (time: number, easing: Keyframe['easing'], bezier?: typeof EASE): Keyframe =>
  ({ id: `k${time}`, time, easing, bezier, value: { kind: 'scalar', value: 0 } } as unknown as Keyframe);

describe('keyEaseFacts', () => {
  it('reads the arrival from the PREVIOUS key and the departure from this one', () => {
    const f = keyEaseFacts(key(0, 'bezier', EASE), key(1, 'linear'), key(2, 'linear'));
    expect(f).toEqual({ hold: false, arrival: 'ease', departure: 'linear' });
  });

  it('has no arrival on a first key and no departure on a last one', () => {
    expect(keyEaseFacts(undefined, key(0, 'bezier', EASE), key(1, 'linear')).arrival).toBeNull();
    expect(keyEaseFacts(key(0, 'linear'), key(1, 'bezier', EASE), undefined).departure).toBeNull();
  });

  it('treats an arrival after a hold as not existing (the hold jumps)', () => {
    expect(keyEaseFacts(key(0, 'hold'), key(1, 'linear'), undefined).arrival).toBeNull();
    expect(keyEaseFacts(key(0, 'step'), key(1, 'linear'), undefined).arrival).toBeNull();
  });

  it('reads both hold spellings', () => {
    expect(keyEaseFacts(undefined, key(0, 'hold'), key(1, 'linear')).hold).toBe(true);
    expect(keyEaseFacts(undefined, key(0, 'step'), key(1, 'linear')).hold).toBe(true);
  });

  it('reads a bezier handle on the diagonal as straight, and others as neither', () => {
    // Departure straight, arrival still eased: the state Linear-on-one-side used to leave.
    const half = { x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 1 };
    expect(keyEaseFacts(key(0, 'bezier', half), key(1, 'bezier', half), key(2, 'linear')))
      .toEqual({ hold: false, arrival: 'ease', departure: 'linear' });
    const custom = { x1: 0.5, y1: 0.2, x2: 0.6, y2: 0.9 };
    expect(keyEaseFacts(key(0, 'bezier', custom), key(1, 'bezier', custom), key(2, 'linear')))
      .toEqual({ hold: false, arrival: 'other', departure: 'other' });
  });
});

describe('activeEase', () => {
  const f = (arrival: Side, departure: Side, hold = false) => ({ hold, arrival, departure });
  it('is Ease only when every existing side is eased', () => {
    expect(activeEase([f('ease', 'ease'), f(null, 'ease')])).toBe('Ease');
    expect(activeEase([f('ease', 'ease'), f('linear', 'ease')])).toBeNull();
  });

  it('distinguishes In from Out from Ease', () => {
    expect(activeEase([f('ease', 'linear')])).toBe('EaseIn');
    expect(activeEase([f('linear', 'ease')])).toBe('EaseOut');
  });

  it('does not light In for a first key, where Ease In is a no-op', () => {
    expect(activeEase([f(null, 'linear')])).toBe('Linear');
  });

  it('is Linear only when BOTH sides are straight', () => {
    expect(activeEase([f('linear', 'linear')])).toBe('Linear');
    // Eased in, straight out: not Linear — this is the case the old one-sided Linear left behind.
    expect(activeEase([f('ease', 'linear')])).not.toBe('Linear');
  });

  it('is Hold only when every key holds, and nothing for a mix', () => {
    expect(activeEase([f(null, null, true), f(null, null, true)])).toBe('Hold');
    expect(activeEase([f(null, null, true), f('ease', 'ease')])).toBeNull();
  });

  it('shows nothing for no keys, a lone key with no sides, or custom curves', () => {
    expect(activeEase([])).toBeNull();
    expect(activeEase([f(null, null)])).toBeNull();
    expect(activeEase([f('other', 'other')])).toBeNull();
  });
});

describe('landingCollisions', () => {
  it('counts the keys a move lands on, per property', () => {
    expect(landingCollisions([{ moving: [0, 10], others: [20, 30] }], 20, 0)).toBe(2);
    expect(landingCollisions([{ moving: [0, 10], others: [20, 35] }], 20, 0)).toBe(1);
    expect(landingCollisions([{ moving: [0], others: [5] }, { moving: [0], others: [5] }], 5, 0)).toBe(2);
  });

  it('counts a key once even when two moving keys reach it', () => {
    expect(landingCollisions([{ moving: [0, 0.00001], others: [5] }], 5, 0.001)).toBe(1);
  });

  it('is zero for a move into free time or onto the moving keys own old times', () => {
    expect(landingCollisions([{ moving: [0, 10], others: [] }], 10, 0)).toBe(0);
    expect(landingCollisions([{ moving: [0], others: [12] }], 10, 0.5)).toBe(0);
  });
});

describe('toolbarStep', () => {
  const all = [true, true, true, true];
  it('moves right and left and wraps', () => {
    expect(toolbarStep(0, 'ArrowRight', all)).toBe(1);
    expect(toolbarStep(3, 'ArrowRight', all)).toBe(0);
    expect(toolbarStep(0, 'ArrowLeft', all)).toBe(3);
  });

  it('skips disabled buttons', () => {
    expect(toolbarStep(0, 'ArrowRight', [true, false, false, true])).toBe(3);
    expect(toolbarStep(3, 'ArrowLeft', [true, false, false, true])).toBe(0);
  });

  it('goes to the enabled ends with Home and End', () => {
    expect(toolbarStep(2, 'Home', [false, true, true, true])).toBe(1);
    expect(toolbarStep(0, 'End', [true, true, true, false])).toBe(2);
  });

  it('ignores other keys and a toolbar with nothing enabled', () => {
    expect(toolbarStep(0, 'Enter', all)).toBe(-1);
    expect(toolbarStep(0, 'ArrowRight', [false, false])).toBe(-1);
  });
});
