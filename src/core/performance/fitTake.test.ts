import { detailToTolerance, evaluateFitted, fitTake, takeRange, type FittedKey, type TakeSample } from './fitTake';

const FPS = 30;
const FD = 1 / FPS;

/** Samples of `f` at `rate` Hz over [t0, t1]. */
function record(f: (t: number) => number[], t0: number, t1: number, rate = 60): TakeSample[] {
  const out: TakeSample[] = [];
  const n = Math.round((t1 - t0) * rate);
  for (let i = 0; i <= n; i++) {
    const t = t0 + i / rate;
    out.push({ t, v: f(t) });
  }
  return out;
}

/** Largest distance between the keys' playback and `f`, checked on every frame of [t0, t1]. */
function maxError(keys: readonly FittedKey[], f: (t: number) => number[], t0: number, t1: number): number {
  let worst = 0;
  for (let fr = Math.ceil(t0 * FPS); fr <= Math.floor(t1 * FPS); fr++) {
    const t = fr * FD;
    const got = evaluateFitted(keys, t);
    const want = f(t);
    const d = Math.sqrt(want.reduce((s, w, i) => s + (w - (got[i] ?? 0)) ** 2, 0));
    if (d > worst) worst = d;
  }
  return worst;
}

describe('fitTake', () => {
  it('returns nothing for an empty take and one key for a take shorter than a frame', () => {
    expect(fitTake([], { frameDuration: FD, tolerance: 1 })).toEqual([]);
    const one = fitTake([{ t: 1, v: [5, 6] }, { t: 1.001, v: [7, 8] }], { frameDuration: FD, tolerance: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.value).toEqual([7, 8]);
  });

  it('turns a constant-speed straight move into two linear keys', () => {
    const f = (t: number): number[] => [200 * t, 100 * t];
    const keys = fitTake(record(f, 0, 2), { frameDuration: FD, tolerance: 1, spatial: true });
    expect(keys).toHaveLength(2);
    expect(keys[0]!.easing).toBe('linear');
    expect(keys[1]!.value).toEqual([400, 200]);
  });

  it('keeps a pause on a straight line as a hold, not a drift', () => {
    // 0→1 s move to 200, hold until 2 s, then on to 400 — all on one line, the
    // case spatial-only simplification turns into one slow drift.
    const f = (t: number): number[] => [t < 1 ? 200 * t : t < 2 ? 200 : 200 + 200 * (t - 2), 0];
    const keys = fitTake(record(f, 0, 3), { frameDuration: FD, tolerance: 1, spatial: true });
    expect(keys.some((k) => k.easing === 'hold')).toBe(true);
    expect(evaluateFitted(keys, 1.5)[0]).toBeCloseTo(200, 3);
    expect(maxError(keys, f, 0, 3)).toBeLessThanOrEqual(1.01);
  });

  it('puts a key at each turn of a bounce, with the error inside the tolerance', () => {
    const f = (t: number): number[] => [100 * Math.abs(Math.sin(Math.PI * t))];
    const keys = fitTake(record(f, 0, 2), { frameDuration: FD, tolerance: 0.5 });
    expect(keys.length).toBeLessThanOrEqual(12);
    expect(maxError(keys, f, 0, 2)).toBeLessThanOrEqual(0.51);
    // The apex frames are keys (turning points), not interpolated through.
    expect(keys.some((k) => Math.abs(k.t - 0.5) < FD / 2)).toBe(true);
    expect(keys.some((k) => Math.abs(k.t - 1.5) < FD / 2)).toBe(true);
  });

  it('fits a circle with a handful of smooth bezier keys', () => {
    const f = (t: number): number[] => [960 + 200 * Math.cos(Math.PI * t), 540 + 200 * Math.sin(Math.PI * t)];
    const keys = fitTake(record(f, 0, 2), { frameDuration: FD, tolerance: 1, spatial: true });
    expect(keys.length).toBeLessThanOrEqual(8);
    expect(maxError(keys, f, 0, 2)).toBeLessThanOrEqual(1.01);
    // Tangents are shared across a key: the in-tangent is the reverse of the out-tangent's direction.
    for (const k of keys.slice(1, -1)) {
      const [ix, iy] = k.spatialIn;
      const [ox, oy] = k.spatialOut;
      const cross = ix! * oy! - iy! * ox!;
      expect(Math.abs(cross) / (Math.hypot(ix!, iy!) * Math.hypot(ox!, oy!))).toBeLessThan(1e-3);
    }
  });

  it('absorbs jitter smaller than the tolerance', () => {
    const f = (t: number): number[] => [300 * t + 0.3 * Math.sin(97 * t), 0.3 * Math.cos(131 * t)];
    const keys = fitTake(record(f, 0, 2, 120), { frameDuration: FD, tolerance: 2, spatial: true });
    expect(keys.length).toBeLessThanOrEqual(3);
  });

  it('lands every key on a whole frame', () => {
    const f = (t: number): number[] => [50 * Math.sin(3 * t)];
    const keys = fitTake(record(f, 0.013, 1.7, 240), { frameDuration: FD, tolerance: 0.2 });
    for (const k of keys) expect(Math.abs(k.t * FPS - Math.round(k.t * FPS))).toBeLessThan(1e-6);
  });

  it('never overshoots the recorded range (bounded properties stay legal)', () => {
    const f = (t: number): number[] => [t < 0.5 ? 0 : t < 1 ? 200 * (t - 0.5) : 100];
    const keys = fitTake(record(f, 0, 2), { frameDuration: FD, tolerance: 0.5 });
    for (let fr = 0; fr <= 2 * FPS; fr++) {
      const v = evaluateFitted(keys, fr * FD)[0]!;
      expect(v).toBeGreaterThanOrEqual(-1e-6);
      expect(v).toBeLessThanOrEqual(100 + 1e-6);
    }
  });

  it('gives the same keys from a 240 Hz pointer and a 30 Hz camera', () => {
    const f = (t: number): number[] => [400 * t * t, 80 * t];
    const a = fitTake(record(f, 0, 1.5, 240), { frameDuration: FD, tolerance: 1, spatial: true });
    const b = fitTake(record(f, 0, 1.5, 30), { frameDuration: FD, tolerance: 1, spatial: true });
    expect(a.map((k) => k.t)).toEqual(b.map((k) => k.t));
  });

  it('is deterministic and tolerates unsorted, duplicated samples', () => {
    const f = (t: number): number[] => [100 * Math.sin(2 * t), 60 * Math.cos(3 * t)];
    const s = record(f, 0, 2);
    const shuffled = [...s.slice(40), s[3]!, ...s.slice(0, 40)];
    const a = fitTake(shuffled, { frameDuration: FD, tolerance: 0.5, spatial: true });
    const b = fitTake(s, { frameDuration: FD, tolerance: 0.5, spatial: true });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('keeps the take\'s own grid when whole frames are off', () => {
    const keys = fitTake(record((t) => [10 * t], 0.01, 1.01), { frameDuration: FD, tolerance: 0.1, wholeFrames: false });
    expect(keys[0]!.t).toBeCloseTo(0.01, 9);
    expect(keys[keys.length - 1]!.t).toBeCloseTo(1.01, 9);
  });
});

describe('detailToTolerance / takeRange', () => {
  it('maps detail onto a logarithmic share of the range', () => {
    expect(detailToTolerance(0, 1000)).toBeCloseTo(50, 6);
    expect(detailToTolerance(50, 1000)).toBeCloseTo(5, 6);
    expect(detailToTolerance(100, 1000)).toBeCloseTo(0.5, 6);
    expect(detailToTolerance(50, 0)).toBeGreaterThan(0);
  });

  it('measures the bounding-box diagonal', () => {
    expect(takeRange([{ t: 0, v: [0, 0] }, { t: 1, v: [30, 40] }])).toBeCloseTo(50, 9);
    expect(takeRange([])).toBe(0);
  });
});
