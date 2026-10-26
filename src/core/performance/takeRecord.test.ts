import { secondsToFlicks } from '@motion/engine-api';
import { keysOutsideSpan, MAX_TAKE_SAMPLES, packSamples, performanceTakeOf, takeSpan, unpackSamples } from './takeRecord';

const FIT = { reduction: 'smart', detail: 50, captureSpeedPct: 100, wholeFrames: true, holdSeconds: 0.25, frameDuration: 1 / 30, spatial: true };

describe('packSamples / unpackSamples', () => {
  it('flattens dims per sample and comes back identical', () => {
    const samples = [{ t: 0, v: [1, 2] }, { t: 0.5, v: [3, 4] }, { t: 1, v: [5, 6] }];
    const packed = packSamples(samples);
    expect(packed).toEqual({ dims: 2, times: [0, 0.5, 1], values: [1, 2, 3, 4, 5, 6] });
    expect(unpackSamples(packed)).toEqual(samples);
  });

  it('pads a short sample and cuts a long one to the first sample\'s dimensions', () => {
    const packed = packSamples([{ t: 0, v: [1, 2] }, { t: 1, v: [3] }, { t: 2, v: [4, 5, 6] }]);
    expect(packed.values).toEqual([1, 2, 3, 0, 4, 5]);
  });

  it('a scalar take has one dimension', () => {
    expect(packSamples([{ t: 0, v: [7] }])).toEqual({ dims: 1, times: [0], values: [7] });
    expect(unpackSamples({ dims: 1, times: [0, 1], values: [7, 8] })).toEqual([{ t: 0, v: [7] }, { t: 1, v: [8] }]);
  });
});

describe('takeSpan / keysOutsideSpan', () => {
  it('spans the first to the last key, in flicks', () => {
    expect(takeSpan([1, 0.5, 2])).toEqual({ start: secondsToFlicks(0.5), duration: secondsToFlicks(2) - secondsToFlicks(0.5) });
    expect(takeSpan([])).toEqual({ start: 0, duration: 0 });
  });

  it('keeps the keys outside the span and drops the take\'s own', () => {
    const key = (s: number) => ({ time: secondsToFlicks(s) }) as never;
    const keys = [key(0.2), key(0.5), key(1), key(2), key(5)];
    const kept = keysOutsideSpan(keys, takeSpan([0.5, 2]));
    expect(kept.map((k) => k.time)).toEqual([secondsToFlicks(0.2), secondsToFlicks(5)]);
  });
});

describe('performanceTakeOf', () => {
  it('builds the record', () => {
    const take = performanceTakeOf({ layer: 'L', path: 'transform/position', source: 'mouse', samples: [{ t: 0, v: [1, 2] }, { t: 1, v: [3, 4] }], fit: FIT, keyTimes: [0, 1] });
    expect(take).toEqual({
      layer: 'L', path: 'transform/position', source: 'mouse', dims: 2, times: [0, 1], values: [1, 2, 3, 4], fit: FIT,
      span: { start: 0, duration: secondsToFlicks(1) },
    });
  });

  it('refuses an empty take and one over the cap (10 minutes at 60 Hz)', () => {
    expect(performanceTakeOf({ layer: 'L', path: 'p', source: 'mouse', samples: [], fit: FIT, keyTimes: [] })).toBeNull();
    const samples = Array.from({ length: MAX_TAKE_SAMPLES + 1 }, (_, i) => ({ t: i / 60, v: [i] }));
    expect(performanceTakeOf({ layer: 'L', path: 'p', source: 'mouse', samples, fit: FIT, keyTimes: [0, 600] })).toBeNull();
    expect(performanceTakeOf({ layer: 'L', path: 'p', source: 'mouse', samples: samples.slice(0, MAX_TAKE_SAMPLES), fit: FIT, keyTimes: [0, 600] })).not.toBeNull();
  });
});
