import { fitTimeSpan, fitValueRange, panValueRange, zoomValueRange } from './graphValueView';
import { valueToY, yToValue } from './graphReferenceCurve';

const H = 160;

describe('zoomValueRange', () => {
  it('keeps the value under the cursor where it is and scales the span', () => {
    const r = { minV: -10, maxV: 90 };
    const cy = 40; // a quarter of the way down → 65 in value space
    const anchor = yToValue(cy, r.minV, r.maxV, H);
    const z = zoomValueRange(r, cy, H, 1 / 1.15);
    expect(z.maxV - z.minV).toBeCloseTo(100 / 1.15, 9);
    expect(valueToY(anchor, z.minV, z.maxV, H)).toBeCloseTo(cy, 9);
  });

  it('zooming out is the inverse of zooming in', () => {
    const r = { minV: 0, maxV: 1 };
    const back = zoomValueRange(zoomValueRange(r, 30, H, 1 / 1.15), 30, H, 1.15);
    expect(back.minV).toBeCloseTo(0, 12);
    expect(back.maxV).toBeCloseTo(1, 12);
  });

  it('refuses to collapse the span to nothing or to blow it up', () => {
    const tiny = { minV: 0, maxV: 1e-6 };
    expect(zoomValueRange(tiny, 80, H, 0.5)).toBe(tiny);
    const huge = { minV: 0, maxV: 1e12 };
    expect(zoomValueRange(huge, 80, H, 2)).toBe(huge);
    expect(zoomValueRange({ minV: 1, maxV: 1 }, 80, H, 0.5)).toEqual({ minV: 1, maxV: 1 });
  });
});

describe('panValueRange', () => {
  it('moves the content with the pointer: a drag down shows smaller values', () => {
    const r = { minV: 0, maxV: 160 }; // one value per pixel
    const p = panValueRange(r, 10, H);
    expect(p).toEqual({ minV: 10, maxV: 170 });
    // The value that was at y = 50 now draws at y = 60.
    const v = yToValue(50, r.minV, r.maxV, H);
    expect(valueToY(v, p.minV, p.maxV, H)).toBeCloseTo(60, 9);
  });

  it('is a no-op for a zero or non-finite delta', () => {
    const r = { minV: 0, maxV: 1 };
    expect(panValueRange(r, 0, H)).toBe(r);
    expect(panValueRange(r, Number.NaN, H)).toBe(r);
  });
});

describe('fitValueRange', () => {
  it('pads a value range like the auto-fit and anchors speed at zero', () => {
    expect(fitValueRange([0, 50], 'value')).toEqual({ minV: -7.5, maxV: 57.5 });
    expect(fitValueRange([20, 40], 'speed')).toEqual({ minV: 0, maxV: 50 });
    expect(fitValueRange([7, 7], 'value')).toEqual({ minV: 6, maxV: 8 });
  });

  it('has nothing to fit without a finite value', () => {
    expect(fitValueRange([], 'value')).toBeNull();
    expect(fitValueRange([Number.NaN], 'value')).toBeNull();
  });
});

describe('fitTimeSpan', () => {
  it('pads the keys’ extent 15 % either side, never before zero', () => {
    expect(fitTimeSpan([1, 2, 3])).toEqual({ t0: 1 - 0.3, t1: 3 + 0.3 });
    expect(fitTimeSpan([0, 1])).toEqual({ t0: 0, t1: 1.15 });
  });

  it('is null for one key or none — no span to zoom to', () => {
    expect(fitTimeSpan([2])).toBeNull();
    expect(fitTimeSpan([])).toBeNull();
  });
});
