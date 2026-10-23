/**
 * Performance take → keyframes: the time-aware fit
 * (docs/PERFORMANCE_ANIMATION_PLAN.md §3.4).
 *
 * A take is a stream of timestamped values — a dragged layer's position, a
 * scrubbed rotation, later a tracked hand. Writing one key per sample is
 * faithful and unusable; the spatial-only Douglas–Peucker that Puppet Sketch
 * uses is compact but blind to time, so a pause on a straight line becomes a
 * slow drift. This fit is compact AND keeps the timing.
 *
 * ## Fitted to the model the engine evaluates
 *
 * `motion_eval`'s sampler (and `@motion/animation`'s, bit-for-bit) evaluates a
 * segment per dimension as
 *
 *     value(t) = cubic(a, a + spatialOut, b + spatialIn, b; ease(u))
 *
 * where `u` is the segment's local time and `ease` is the CSS cubic-bézier of
 * the key that starts it. A segment is therefore a PATH (the cubic, shaped by
 * the spatial tangents) travelled at a SPEED PROFILE (the ease). The fit
 * produces exactly those two things, so the keys it writes are the keys an
 * animator would set by hand in After Effects: motion-path handles plus
 * speed / influence eases, editable in the graph editor as such.
 *
 *   * `spatial` (Position): the path is a cubic Bézier fitted with Schneider's
 *     method; the ease maps time onto the Bézier's parameter.
 *   * otherwise (rotation, opacity, scale, an effect value): no tangents — the
 *     path is the straight line between the keys and the ease is the whole
 *     shape. A scalar is the one-dimensional case.
 *
 * ## The steps
 *
 *   1. resample onto the frame grid — keys land on frames, and a 240 Hz
 *      pointer and a 30 Hz camera give the same result;
 *   2. holds — the value staying within half the tolerance for at least
 *      `holdSeconds` — become a `hold` key where the hold starts and a key
 *      where the motion resumes;
 *   3. each moving span is fitted; where the worst frame is further than the
 *      tolerance the span splits there and both halves are fitted again. A
 *      turning point (a scalar's extremum, a path's reversal) is the worst
 *      frame of any span across it, so splits land on turning points first;
 *   4. eases are fitted AE-style: the SPEED at a key is the measured velocity
 *      there, shared by the segments on both sides (no velocity jump at a key),
 *      and only the two INFLUENCES are searched. At a turning point or a hold
 *      the velocity is zero, which is the natural ease in / ease out.
 *
 * Pure and deterministic: fixed iteration counts and a fixed search grid, no
 * clock, no randomness. Same take in, same keys out.
 */

import { cubicBezierEase, cubicValueAt } from '@motion/animation';

/** One recorded instant: comp seconds and the target's value (one entry per dimension). */
export interface TakeSample {
  t: number;
  v: readonly number[];
}

export interface FitOptions {
  /** Seconds per composition frame — the grid keys land on. */
  frameDuration: number;
  /** Largest allowed distance between the take and the fitted curve, in value units (Euclidean across dimensions). */
  tolerance: number;
  /** Shortest stillness that becomes a hold. Default 0.25 s. */
  holdSeconds?: number;
  /** Fit a motion path with spatial tangents (Position). Default false. */
  spatial?: boolean;
  /** Snap the grid to whole frames (default true); false keeps the take's own start. */
  wholeFrames?: boolean;
}

export interface EaseHandles {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A key as the engine stores one: the easing and handles describe the segment that STARTS here. */
export interface FittedKey {
  t: number;
  value: number[];
  easing: 'linear' | 'bezier' | 'hold';
  bezier?: EaseHandles;
  /** Spatial fits only: value-space offsets per dimension; empty = none. */
  spatialIn: number[];
  spatialOut: number[];
}

export const DEFAULT_HOLD_SECONDS = 0.25;

/** Detail 0 → 5 % of the take's range, 100 → 0.05 %; logarithmic between (50 → 0.5 %). */
export function detailToTolerance(detail: number, range: number): number {
  const d = Math.max(0, Math.min(100, Number.isFinite(detail) ? detail : 50)) / 100;
  const frac = 10 ** (Math.log10(0.05) + (Math.log10(0.0005) - Math.log10(0.05)) * d);
  return Math.max(1e-4, range * frac);
}

/** The diagonal of the take's bounding box — the "range" the Detail control is relative to. */
export function takeRange(samples: readonly TakeSample[]): number {
  if (samples.length === 0) return 0;
  const dims = samples[0]!.v.length;
  let sum = 0;
  for (let d = 0; d < dims; d++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of samples) {
      const x = s.v[d] ?? 0;
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    sum += (hi - lo) ** 2;
  }
  return Math.sqrt(sum);
}

// ── Vector helpers (plain arrays; takes are short and this is not a hot path) ──

type Vec = number[];

const sub = (a: readonly number[], b: readonly number[]): Vec => a.map((x, i) => x - (b[i] ?? 0));
const add = (a: readonly number[], b: readonly number[]): Vec => a.map((x, i) => x + (b[i] ?? 0));
const scale = (a: readonly number[], k: number): Vec => a.map((x) => x * k);
const dot = (a: readonly number[], b: readonly number[]): number => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);
const norm = (a: readonly number[]): number => Math.sqrt(dot(a, a));
const dist = (a: readonly number[], b: readonly number[]): number => norm(sub(a, b));

// ── 1. Resample onto the frame grid ────────────────────────────────────────────

interface Grid {
  t: number[];
  p: Vec[];
}

/** Sorted, same-instant samples collapsed to the LAST (the most current reading), non-finite ones dropped. */
function cleanSamples(samples: readonly TakeSample[]): TakeSample[] {
  const ok = samples.filter((s) => Number.isFinite(s.t) && s.v.length > 0 && s.v.every(Number.isFinite));
  // Stable sort: equal times keep their arrival order, so "last wins" below is the last to arrive.
  const sorted = ok.map((s, i) => ({ s, i })).sort((a, b) => a.s.t - b.s.t || a.i - b.i).map((x) => x.s);
  const out: TakeSample[] = [];
  for (const s of sorted) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.t - s.t) < 1e-9) out[out.length - 1] = s;
    else out.push(s);
  }
  return out;
}

function resample(samples: readonly TakeSample[], fd: number, wholeFrames: boolean): Grid {
  const t0 = samples[0]!.t;
  const t1 = samples[samples.length - 1]!.t;
  const times: number[] = [];
  if (wholeFrames) {
    const f0 = Math.round(t0 / fd);
    const f1 = Math.round(t1 / fd);
    for (let f = f0; f <= Math.max(f0, f1); f++) times.push(f * fd);
  } else {
    for (let t = t0; t < t1 - fd * 0.5; t += fd) times.push(t);
    times.push(t1);
  }
  const p: Vec[] = [];
  let j = 0;
  for (const tt of times) {
    const t = Math.max(t0, Math.min(t1, tt));
    while (j < samples.length - 2 && samples[j + 1]!.t < t) j++;
    const a = samples[j]!;
    const b = samples[Math.min(j + 1, samples.length - 1)]!;
    const span = b.t - a.t;
    const k = span > 1e-12 ? Math.max(0, Math.min(1, (t - a.t) / span)) : 1;
    p.push(a.v.map((x, d) => x + ((b.v[d] ?? x) - x) * k));
  }
  return { t: times, p };
}

/**
 * Velocity at grid index `i`: the slope at `i` of a least-squares QUADRATIC
 * over five frames — centred where it can be, shifted inward at the ends. A
 * straight-line slope is the velocity at the window's middle, which at the
 * first frame of a curved take is a frame or two late and points the path's
 * end tangent the wrong way; the quadratic's slope is taken at `i` itself.
 */
function velocityAt(g: Grid, i: number): Vec {
  const n = g.t.length;
  const dims = g.p[i]!.length;
  const zero = new Array<number>(dims).fill(0);
  if (n < 2) return zero;
  const w = Math.min(5, n);
  const lo = Math.max(0, Math.min(i - 2, n - w));
  const hi = lo + w - 1;
  const ti = g.t[i]!;
  if (w < 3) {
    const dt = g.t[hi]! - g.t[lo]!;
    return dt > 1e-12 ? sub(g.p[hi]!, g.p[lo]!).map((x) => x / dt) : zero;
  }
  // Normal equations of p(t) ≈ c0 + c1·x + c2·x², x = t − t_i; the slope at i is c1.
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  const r0 = zero.slice(), r1 = zero.slice(), r2 = zero.slice();
  for (let k = lo; k <= hi; k++) {
    const x = g.t[k]! - ti;
    const x2 = x * x;
    s0 += 1; s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
    for (let d = 0; d < dims; d++) {
      const y = g.p[k]![d]!;
      r0[d]! += y; r1[d]! += x * y; r2[d]! += x2 * y;
    }
  }
  // Cramer's rule for c1 of [[s0 s1 s2],[s1 s2 s3],[s2 s3 s4]]·c = r.
  const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
  if (Math.abs(det) < 1e-30) return zero;
  return zero.map((_, d) => {
    const a = r0[d]!, b = r1[d]!, c = r2[d]!;
    return (s0 * (b * s4 - s3 * c) - a * (s1 * s4 - s3 * s2) + s2 * (s1 * c - b * s2)) / det;
  });
}

// ── 2. Holds ────────────────────────────────────────────────────────────────────

/** Runs [i, j] where every frame stays within `eps` of frame i for at least `minSeconds`. */
function findHolds(g: Grid, eps: number, minSeconds: number): Array<[number, number]> {
  const n = g.t.length;
  const holds: Array<[number, number]> = [];
  let i = 0;
  while (i < n - 1) {
    let j = i;
    while (j + 1 < n && dist(g.p[j + 1]!, g.p[i]!) <= eps) j++;
    if (j > i && g.t[j]! - g.t[i]! >= minSeconds - 1e-9) {
      holds.push([i, j]);
      i = j;
    } else {
      i++;
    }
  }
  return holds;
}

// ── 3–4. Span fitting ───────────────────────────────────────────────────────────

/** One fitted segment from grid index i0 to i1. */
interface Segment {
  i0: number;
  i1: number;
  easing: FittedKey['easing'];
  bezier?: EaseHandles;
  /** Spatial fits: out-tangent of key i0 and in-tangent of key i1 (value-space offsets). */
  so?: Vec;
  si?: Vec;
}

interface SpanFit {
  seg: Segment;
  /** Largest distance of a frame from the fitted curve. */
  err: number;
  /** The grid index where that is. */
  worst: number;
}

const INFLUENCE_GRID = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];

/**
 * The ease of a segment, AE-style: the start and end SLOPES are fixed by the
 * measured speeds (`m0`, `m1`, in normalized progress per normalized time) and
 * only the influences are searched. `cost(h)` is the sum of squared errors of
 * the segment under handles `h`. A fixed grid, then three fixed refinements —
 * no tolerance-driven loop, so the result is deterministic.
 */
function fitEase(m0: number, m1: number, cost: (h: EaseHandles) => number): EaseHandles {
  const handles = (in0: number, in1: number): EaseHandles => ({
    x1: in0,
    y1: Math.min(1, Math.max(0, m0 * in0)),
    x2: 1 - in1,
    y2: Math.max(0, Math.min(1, 1 - m1 * in1)),
  });
  let best = { a: 1 / 3, b: 1 / 3, c: Infinity };
  for (const a of INFLUENCE_GRID) {
    for (const b of INFLUENCE_GRID) {
      const c = cost(handles(a, b));
      if (c < best.c - 1e-12) best = { a, b, c };
    }
  }
  for (const step of [0.05, 0.025, 0.0125]) {
    const centre = best;
    for (const da of [-step, 0, step]) {
      for (const db of [-step, 0, step]) {
        const a = Math.max(0.01, Math.min(0.99, centre.a + da));
        const b = Math.max(0.01, Math.min(0.99, centre.b + db));
        const c = cost(handles(a, b));
        if (c < best.c - 1e-12) best = { a, b, c };
      }
    }
  }
  return handles(best.a, best.b);
}

const easeOf = (h: EaseHandles, u: number): number => cubicBezierEase([h.x1, h.y1, h.x2, h.y2], u);

/** The worst frame of i0..i1 against `model(k)` (interior frames; the ends are exact by construction). */
function worstOf(g: Grid, i0: number, i1: number, model: (k: number) => Vec): { err: number; worst: number } {
  let err = 0;
  let worst = Math.floor((i0 + i1) / 2);
  for (let k = i0 + 1; k < i1; k++) {
    const e = dist(model(k), g.p[k]!);
    if (e > err) {
      err = e;
      worst = k;
    }
  }
  return { err, worst };
}

function linearSpan(g: Grid, i0: number, i1: number): SpanFit {
  const a = g.p[i0]!;
  const b = g.p[i1]!;
  const t0 = g.t[i0]!;
  const dur = g.t[i1]! - t0;
  const { err, worst } = worstOf(g, i0, i1, (k) => add(a, scale(sub(b, a), dur > 0 ? (g.t[k]! - t0) / dur : 0)));
  return { seg: { i0, i1, easing: 'linear' }, err, worst };
}

/** Non-spatial span: the straight line from a to b, travelled at a fitted ease. */
function fitChordSpan(g: Grid, i0: number, i1: number, v0: Vec, v1: Vec, tol: number): SpanFit {
  const lin = linearSpan(g, i0, i1);
  // A clean constant-speed move stays linear: simpler keys, nothing lost.
  if (lin.err <= tol * 0.5) return lin;
  const a = g.p[i0]!;
  const b = g.p[i1]!;
  const d = sub(b, a);
  const L2 = dot(d, d);
  // Start and end (nearly) equal: no line to travel — the split at the worst
  // frame (the turning point) is what this span needs.
  if (L2 < (tol * 0.25) ** 2) return lin;
  const t0 = g.t[i0]!;
  const dur = g.t[i1]! - t0;
  const m0 = Math.max(0, (dot(v0, d) / L2) * dur);
  const m1 = Math.max(0, (dot(v1, d) / L2) * dur);
  const at = (h: EaseHandles, k: number): Vec => add(a, scale(d, easeOf(h, (g.t[k]! - t0) / dur)));
  const h = fitEase(m0, m1, (hh) => {
    let c = 0;
    for (let k = i0 + 1; k < i1; k++) c += dist(at(hh, k), g.p[k]!) ** 2;
    return c;
  });
  const { err, worst } = worstOf(g, i0, i1, (k) => at(h, k));
  if (err >= lin.err) return lin;
  return { seg: { i0, i1, easing: 'bezier', bezier: h }, err, worst };
}

/** The unit tangent leaving `i0` (dir = +1) or arriving at `i1` (dir = −1): velocity, else the first point that moved. */
function tangentDir(g: Grid, i: number, iEnd: number, v: Vec, tol: number, dir: 1 | -1): Vec {
  const sp = norm(v);
  if (sp > 1e-9) return scale(v, 1 / sp);
  const p = g.p[i]!;
  for (let k = i + dir; dir > 0 ? k <= iEnd : k >= iEnd; k += dir) {
    const off = dir > 0 ? sub(g.p[k]!, p) : sub(p, g.p[k]!);
    const l = norm(off);
    if (l > tol * 0.5 || k === iEnd) return l > 1e-12 ? scale(off, 1 / l) : off;
  }
  return new Array<number>(p.length).fill(0);
}

function bezierPoint(a: Vec, c1: Vec, c2: Vec, b: Vec, s: number): Vec {
  return a.map((_, d) => cubicValueAt(a[d]!, c1[d]!, c2[d]!, b[d]!, s));
}

/** Newton step of Schneider's reparameterization: the parameter on the curve nearest `p`, from `s`. */
function reparam(a: Vec, c1: Vec, c2: Vec, b: Vec, p: Vec, s: number): number {
  const m = 1 - s;
  const q = bezierPoint(a, c1, c2, b, s);
  // First and second derivatives of the cubic at s.
  const q1 = a.map((_, d) => 3 * (m * m * (c1[d]! - a[d]!) + 2 * m * s * (c2[d]! - c1[d]!) + s * s * (b[d]! - c2[d]!)));
  const q2 = a.map((_, d) => 6 * (m * (c2[d]! - 2 * c1[d]! + a[d]!) + s * (b[d]! - 2 * c2[d]! + c1[d]!)));
  const diff = sub(q, p);
  const num = dot(diff, q1);
  const den = dot(q1, q1) + dot(diff, q2);
  if (Math.abs(den) < 1e-12) return s;
  return Math.max(0, Math.min(1, s - num / den));
}

/** Spatial span: a cubic Bézier path (Schneider) travelled at a fitted ease. */
function fitBezierSpan(g: Grid, i0: number, i1: number, v0: Vec, v1: Vec, tol: number): SpanFit {
  const a = g.p[i0]!;
  const b = g.p[i1]!;
  const n = i1 - i0;
  // Path length decides whether there is a path at all (a loop can end where it began).
  let len = 0;
  for (let k = i0 + 1; k <= i1; k++) len += dist(g.p[k]!, g.p[k - 1]!);
  if (len < tol * 0.25 || n < 2) return linearSpan(g, i0, i1);
  const lin = linearSpan(g, i0, i1);
  if (lin.err <= tol * 0.5) return lin;

  const t0hat = tangentDir(g, i0, i1, v0, tol, 1);
  const t1hat = tangentDir(g, i1, i0, v1, tol, -1);

  // Chord-length parameters to start, then Schneider's alternation.
  const s: number[] = [0];
  let acc = 0;
  for (let k = i0 + 1; k <= i1; k++) {
    acc += dist(g.p[k]!, g.p[k - 1]!);
    s.push(acc / len);
  }
  let alpha0 = len / 3;
  let alpha1 = len / 3;
  for (let iter = 0; iter < 4; iter++) {
    // Least squares for the two handle lengths along the fixed tangent directions.
    let c00 = 0;
    let c01 = 0;
    let c11 = 0;
    let x0 = 0;
    let x1 = 0;
    for (let k = 0; k <= n; k++) {
      const u = s[k]!;
      const m = 1 - u;
      const b0 = m * m * m;
      const b1 = 3 * m * m * u;
      const b2 = 3 * m * u * u;
      const b3 = u * u * u;
      const A1 = scale(t0hat, b1);
      const A2 = scale(t1hat, -b2);
      c00 += dot(A1, A1);
      c01 += dot(A1, A2);
      c11 += dot(A2, A2);
      const tmp = sub(g.p[i0 + k]!, add(scale(a, b0 + b1), scale(b, b2 + b3)));
      x0 += dot(A1, tmp);
      x1 += dot(A2, tmp);
    }
    const det = c00 * c11 - c01 * c01;
    let al0 = Math.abs(det) > 1e-12 ? (x0 * c11 - c01 * x1) / det : 0;
    let al1 = Math.abs(det) > 1e-12 ? (c00 * x1 - c01 * x0) / det : 0;
    // Schneider's guard: a non-positive or vanishing handle means the fit
    // failed; fall back to the third-of-the-chord heuristic.
    const eps = 1e-6 * len;
    if (!(al0 > eps) || !(al1 > eps) || !Number.isFinite(al0) || !Number.isFinite(al1)) {
      al0 = len / 3;
      al1 = len / 3;
    }
    alpha0 = al0;
    alpha1 = al1;
    const c1 = add(a, scale(t0hat, alpha0));
    const c2 = sub(b, scale(t1hat, alpha1));
    for (let k = 1; k < n; k++) s[k] = reparam(a, c1, c2, b, g.p[i0 + k]!, s[k]!);
    // Time runs forward along the path: parameters must not go back.
    for (let k = 1; k <= n; k++) s[k] = Math.max(s[k]!, s[k - 1]!);
    s[n] = 1;
  }
  const c1 = add(a, scale(t0hat, alpha0));
  const c2 = sub(b, scale(t1hat, alpha1));

  const t0 = g.t[i0]!;
  const dur = g.t[i1]! - t0;
  // Speed along the parameter at the ends: |dB/ds| = 3·alpha there.
  const m0 = (norm(v0) * dur) / (3 * alpha0);
  const m1 = (norm(v1) * dur) / (3 * alpha1);
  const at = (h: EaseHandles, k: number): Vec => bezierPoint(a, c1, c2, b, easeOf(h, (g.t[k]! - t0) / dur));
  const h = fitEase(m0, m1, (hh) => {
    let c = 0;
    for (let k = i0 + 1; k < i1; k++) c += dist(at(hh, k), g.p[k]!) ** 2;
    return c;
  });
  const { err, worst } = worstOf(g, i0, i1, (k) => at(h, k));
  if (err >= lin.err) return lin;
  return {
    seg: { i0, i1, easing: 'bezier', bezier: h, so: sub(c1, a), si: sub(c2, b) },
    err,
    worst,
  };
}

const MAX_DEPTH = 40;

function fitSpan(
  g: Grid,
  i0: number,
  i1: number,
  v0: Vec,
  v1: Vec,
  opts: { tol: number; spatial: boolean },
  out: Segment[],
  depth = 0,
): void {
  if (i1 - i0 < 2) {
    out.push({ i0, i1, easing: 'linear' });
    return;
  }
  const fit = opts.spatial ? fitBezierSpan(g, i0, i1, v0, v1, opts.tol) : fitChordSpan(g, i0, i1, v0, v1, opts.tol);
  if (fit.err <= opts.tol || depth >= MAX_DEPTH) {
    out.push(fit.seg);
    return;
  }
  // Split at the worst frame — a turning point is always the worst frame of a
  // span across it — unless the midpoint fits both halves better. The worst
  // frame of a smooth arc sits near an end (where the end tangents pull), and
  // splitting there leaves one sliver and one span still too long; on a
  // circle that is six uneven keys where the midpoint gives four quarters.
  const mid = Math.floor((i0 + i1) / 2);
  const worst = fit.worst > i0 && fit.worst < i1 ? fit.worst : mid;
  const score = (k: number): number => {
    const vk = velocityAt(g, k);
    const l = opts.spatial ? fitBezierSpan(g, i0, k, v0, vk, opts.tol) : fitChordSpan(g, i0, k, v0, vk, opts.tol);
    const r = opts.spatial ? fitBezierSpan(g, k, i1, vk, v1, opts.tol) : fitChordSpan(g, k, i1, vk, v1, opts.tol);
    return Math.max(l.err, r.err);
  };
  const k = worst !== mid && score(mid) < score(worst) ? mid : worst;
  const vk = velocityAt(g, k);
  fitSpan(g, i0, k, v0, vk, opts, out, depth + 1);
  fitSpan(g, k, i1, vk, v1, opts, out, depth + 1);
}

const round = (x: number): number => Math.round(x * 1e4) / 1e4;

/**
 * Fit a take. Returns keys in time order — empty for an empty take, one key
 * for a take shorter than a frame. Values are in the take's own units.
 */
export function fitTake(samples: readonly TakeSample[], opts: FitOptions): FittedKey[] {
  const clean = cleanSamples(samples);
  if (clean.length === 0) return [];
  const fd = opts.frameDuration > 0 && Number.isFinite(opts.frameDuration) ? opts.frameDuration : 1 / 30;
  const tol = Math.max(1e-6, opts.tolerance);
  const spatial = opts.spatial === true && clean[0]!.v.length >= 2;
  const g = resample(clean, fd, opts.wholeFrames !== false);
  const n = g.t.length;
  const lastValue = clean[clean.length - 1]!.v.map(round);
  if (n === 1) return [{ t: g.t[0]!, value: lastValue, easing: 'linear', spatialIn: [], spatialOut: [] }];

  const dims = g.p[0]!.length;
  const zero = (): Vec => new Array<number>(dims).fill(0);
  const segs: Segment[] = [];
  const holds = findHolds(g, tol * 0.5, opts.holdSeconds ?? DEFAULT_HOLD_SECONDS);
  let cursor = 0;
  let vCursor = velocityAt(g, 0);
  for (const [h0, h1] of holds) {
    if (h0 > cursor) fitSpan(g, cursor, h0, vCursor, zero(), { tol, spatial }, segs);
    segs.push({ i0: h0, i1: h1, easing: 'hold' });
    cursor = h1;
    vCursor = zero();
  }
  if (cursor < n - 1) fitSpan(g, cursor, n - 1, vCursor, velocityAt(g, n - 1), { tol, spatial }, segs);

  const keys: FittedKey[] = [];
  let incoming: Vec | undefined;
  for (const s of segs) {
    // A hold freezes the value it starts with: the key carries the hold
    // frame's own value, and the next key (where motion resumes) carries the
    // value it resumes from — within half the tolerance of it.
    keys.push({
      t: g.t[s.i0]!,
      value: g.p[s.i0]!.map(round),
      easing: s.easing,
      ...(s.bezier ? { bezier: { x1: round(s.bezier.x1), y1: round(s.bezier.y1), x2: round(s.bezier.x2), y2: round(s.bezier.y2) } } : {}),
      spatialIn: spatial && incoming ? incoming.map(round) : [],
      spatialOut: spatial && s.so ? s.so.map(round) : [],
    });
    incoming = s.si;
  }
  const last = segs[segs.length - 1]!;
  keys.push({
    t: g.t[last.i1]!,
    value: g.p[last.i1]!.map(round),
    easing: 'linear',
    spatialIn: spatial && incoming ? incoming.map(round) : [],
    spatialOut: [],
  });
  return keys;
}

/**
 * Evaluate fitted keys at `t` with the engine's model — what the keys will
 * play back as. For tests and the take overlay; not on any render path.
 */
export function evaluateFitted(keys: readonly FittedKey[], t: number): number[] {
  if (keys.length === 0) return [];
  if (t <= keys[0]!.t) return keys[0]!.value.slice();
  const lastK = keys[keys.length - 1]!;
  if (t >= lastK.t) return lastK.value.slice();
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1]!.t < t) i++;
  const a = keys[i]!;
  const b = keys[i + 1]!;
  if (a.easing === 'hold') return t < b.t ? a.value.slice() : b.value.slice();
  const u = (t - a.t) / (b.t - a.t);
  const e = a.easing === 'bezier' && a.bezier ? easeOf(a.bezier, u) : Math.max(0, Math.min(1, u));
  const hasTan = a.spatialOut.length > 0 || b.spatialIn.length > 0;
  return a.value.map((av, d) => {
    const bv = b.value[d]!;
    if (!hasTan) return av + (bv - av) * e;
    const third = (bv - av) / 3;
    const c1 = av + (a.spatialOut.length > 0 ? a.spatialOut[d]! : third);
    const c2 = bv + (b.spatialIn.length > 0 ? b.spatialIn[d]! : -third);
    return cubicValueAt(av, c1, c2, bv, e);
  });
}
