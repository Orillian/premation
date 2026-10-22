/**
 * The Record Audio panel's take edits, as pure DSP over planar Float32 audio.
 *
 * A take is never edited in place: `renderTakeEdit(original, params)` returns
 * NEW channel arrays, so "Revert to original" is just dropping the render.
 * Every function here is deterministic (no clocks, no randomness), allocation
 * is per call (none of this runs per played frame), and nothing imports the
 * DOM, React or a store — the same code runs in jest.
 *
 * Processing order (`renderTakeEdit`):
 *   1. trim         in / out, seconds into the take
 *   2. high-pass    2nd-order Butterworth (rumble, handling noise)
 *   3. noise gate   peak envelope, hysteresis, hold, attack / release ramps
 *   4. fades        quarter-sine ramps (no click at either end)
 *   5. normalize    peak to a ceiling and/or integrated loudness (BS.1770-4)
 *   6. gain         the user's own trim in dB, ON TOP of normalize
 */

export interface GateParams {
  /** Opens when the peak envelope rises above this, dBFS. */
  thresholdDb: number;
  /** How far a closed gate turns the signal down, dB (negative; -Infinity = silence). */
  rangeDb: number;
  attackMs: number;
  holdMs: number;
  releaseMs: number;
}

export type NormalizeMode = 'off' | 'peak' | 'loudness' | 'both';

export interface TakeEditParams {
  /** Seconds into the take where the edit starts. */
  trimInSec: number;
  /** Seconds into the take where it ends; null = the end. */
  trimOutSec: number | null;
  /** Extra gain after normalize, dB. */
  gainDb: number;
  normalize: NormalizeMode;
  /** The peak ceiling, dBFS (peak / both). */
  peakCeilingDb: number;
  /** The integrated loudness target, LUFS (loudness / both). */
  loudnessTargetLufs: number;
  fadeInSec: number;
  fadeOutSec: number;
  highPass: { enabled: boolean; hz: number };
  gate: { enabled: boolean } & GateParams;
}

export const DEFAULT_TAKE_EDIT: Readonly<TakeEditParams> = Object.freeze({
  trimInSec: 0,
  trimOutSec: null,
  gainDb: 0,
  normalize: 'off',
  peakCeilingDb: -1,
  loudnessTargetLufs: -16,
  fadeInSec: 0,
  fadeOutSec: 0,
  highPass: Object.freeze({ enabled: false, hz: 80 }),
  gate: Object.freeze({ enabled: false, thresholdDb: -50, rangeDb: -40, attackMs: 2, holdMs: 60, releaseMs: 120 }),
}) as Readonly<TakeEditParams>;

/** Whether a set of edit params changes anything (an untouched take needs no render). */
export function isIdentityEdit(p: TakeEditParams, durationSec: number): boolean {
  return p.trimInSec <= 0
    && (p.trimOutSec === null || p.trimOutSec >= durationSec)
    && p.gainDb === 0
    && p.normalize === 'off'
    && p.fadeInSec <= 0
    && p.fadeOutSec <= 0
    && !p.highPass.enabled
    && !p.gate.enabled;
}

export function dbToGain(db: number): number {
  return db === -Infinity ? 0 : Math.pow(10, db / 20);
}

export function gainToDb(g: number): number {
  return g <= 0 ? -Infinity : 20 * Math.log10(g);
}

/** The highest |sample| across channels in [start, end). */
export function peakOf(channels: ReadonlyArray<Float32Array>, start = 0, end = channels[0]?.length ?? 0): number {
  let peak = 0;
  for (const ch of channels) {
    for (let i = Math.max(0, start); i < Math.min(end, ch.length); i++) {
      const a = Math.abs(ch[i]!);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

/** Copy [start, end) of every channel. */
export function sliceChannels(channels: ReadonlyArray<Float32Array>, start: number, end: number): Float32Array[] {
  return channels.map((ch) => ch.slice(Math.max(0, start), Math.max(Math.max(0, start), Math.min(end, ch.length))));
}

// ── Biquads ────────────────────────────────────────────────────────────

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

/** A 2nd-order Butterworth high-pass (RBJ cookbook, Q = 1/√2). */
export function highPassCoefficients(hz: number, sampleRate: number): Biquad {
  const f = Math.min(Math.max(hz, 1), sampleRate * 0.45);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cos) / 2) / a0,
    b1: -(1 + cos) / a0,
    b2: ((1 + cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** Run a biquad over `x` into a new array (transposed direct form II). */
function runBiquad(x: Float32Array, q: Biquad): Float32Array {
  const y = new Float32Array(x.length);
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s = x[i]!;
    const o = q.b0 * s + z1;
    z1 = q.b1 * s - q.a1 * o + z2;
    z2 = q.b2 * s - q.a2 * o;
    y[i] = o;
  }
  return y;
}

export function highPass(channels: ReadonlyArray<Float32Array>, hz: number, sampleRate: number): Float32Array[] {
  const q = highPassCoefficients(hz, sampleRate);
  return channels.map((ch) => runBiquad(ch, q));
}

// ── Noise gate ─────────────────────────────────────────────────────────

/**
 * A simple downward gate. One envelope for all channels (the loudest), so a
 * stereo take never opens one side and not the other. Opens above the
 * threshold, closes 6 dB below it (hysteresis) once `hold` has elapsed, and
 * ramps its gain linearly over attack / release so it never clicks.
 * Returns new arrays; `gainCurve` (optional) receives the per-frame gain.
 */
export function noiseGate(
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  p: GateParams,
  gainCurve?: Float32Array,
): Float32Array[] {
  const n = channels[0]?.length ?? 0;
  const open = dbToGain(p.thresholdDb);
  const close = dbToGain(p.thresholdDb - 6);
  const floor = dbToGain(Math.min(0, p.rangeDb));
  const attackStep = (1 - floor) / Math.max(1, (p.attackMs / 1000) * sampleRate);
  const releaseStep = (1 - floor) / Math.max(1, (p.releaseMs / 1000) * sampleRate);
  const holdFrames = Math.round((p.holdMs / 1000) * sampleRate);
  // Peak envelope with a ~10 ms decay, so a single zero crossing does not close it.
  const decay = Math.exp(-1 / Math.max(1, 0.01 * sampleRate));
  const out = channels.map((ch) => new Float32Array(ch.length));
  let env = 0;
  let isOpen = false;
  let held = 0;
  let g = floor;
  for (let i = 0; i < n; i++) {
    let peak = 0;
    for (const ch of channels) {
      const a = Math.abs(ch[i]!);
      if (a > peak) peak = a;
    }
    env = peak > env ? peak : env * decay;
    if (env >= open) {
      isOpen = true;
      held = holdFrames;
    } else if (isOpen && env < close) {
      if (held > 0) held--;
      else isOpen = false;
    }
    if (isOpen) g = Math.min(1, g + attackStep);
    else g = Math.max(floor, g - releaseStep);
    for (let c = 0; c < channels.length; c++) out[c]![i] = channels[c]![i]! * g;
    if (gainCurve && i < gainCurve.length) gainCurve[i] = g;
  }
  return out;
}

// ── Fades ──────────────────────────────────────────────────────────────

/** Fade in over the first `inFrames` and out over the last `outFrames`, in place (sine ramps). */
export function applyFades(channels: Float32Array[], inFrames: number, outFrames: number): void {
  const n = channels[0]?.length ?? 0;
  const fi = Math.min(n, Math.max(0, Math.round(inFrames)));
  const fo = Math.min(n, Math.max(0, Math.round(outFrames)));
  for (const ch of channels) {
    for (let i = 0; i < fi; i++) ch[i]! *= Math.sin((Math.PI / 2) * (i / fi));
    for (let i = 0; i < fo; i++) ch[n - 1 - i]! *= Math.sin((Math.PI / 2) * (i / fo));
  }
}

export function applyGain(channels: Float32Array[], gain: number): void {
  if (gain === 1) return;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i]! *= gain;
}

// ── Loudness (ITU-R BS.1770-4 integrated, gated) ───────────────────────

/** The K-weighting pre-filter (high shelf) and RLB high-pass at any rate (libebur128's derivation). */
function kWeighting(sampleRate: number): [Biquad, Biquad] {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + K / Q + K * K;
  const hp: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}

/**
 * Integrated loudness in LUFS: K-weighted mean square over 400 ms blocks
 * (75 % overlap), absolute gate −70 LUFS, relative gate −10 LU. Every channel
 * weighs 1 (mono / stereo). −Infinity for silence or a take under 400 ms of
 * gated signal.
 */
export function integratedLoudness(channels: ReadonlyArray<Float32Array>, sampleRate: number): number {
  const n = channels[0]?.length ?? 0;
  const block = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  if (n < block || block <= 0) return -Infinity;
  const [shelf, hp] = kWeighting(sampleRate);
  // Per-hop sums of squares (summed over channels), then 4-hop blocks.
  const hops = Math.floor(n / hop);
  const hopEnergy = new Float64Array(hops);
  for (const ch of channels) {
    const k = runBiquad(runBiquad(ch, shelf), hp);
    for (let h = 0; h < hops; h++) {
      let s = 0;
      for (let i = h * hop; i < (h + 1) * hop; i++) s += k[i]! * k[i]!;
      hopEnergy[h]! += s;
    }
  }
  const perBlock = block / hop; // 4
  const blocks: number[] = [];
  for (let b = 0; b + perBlock <= hops; b++) {
    let s = 0;
    for (let h = b; h < b + perBlock; h++) s += hopEnergy[h]!;
    blocks.push(s / (perBlock * hop));
  }
  const lufs = (ms: number): number => -0.691 + 10 * Math.log10(ms);
  const absGated = blocks.filter((ms) => ms > 0 && lufs(ms) > -70);
  if (absGated.length === 0) return -Infinity;
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const relThreshold = lufs(mean(absGated)) - 10;
  const relGated = absGated.filter((ms) => lufs(ms) > relThreshold);
  return relGated.length === 0 ? -Infinity : lufs(mean(relGated));
}

/**
 * The gain that normalizes `channels`: peak → ceiling, loudness → target, or
 * both (the loudness gain, capped so the peak stays under the ceiling).
 * 1 for silence or `off`.
 */
export function normalizeGain(
  channels: ReadonlyArray<Float32Array>,
  sampleRate: number,
  mode: NormalizeMode,
  peakCeilingDb: number,
  loudnessTargetLufs: number,
): number {
  if (mode === 'off') return 1;
  const peak = peakOf(channels);
  if (peak <= 0) return 1;
  const peakGain = dbToGain(peakCeilingDb) / peak;
  if (mode === 'peak') return peakGain;
  const lufs = integratedLoudness(channels, sampleRate);
  const loudGain = Number.isFinite(lufs) ? dbToGain(loudnessTargetLufs - lufs) : 1;
  return mode === 'loudness' ? loudGain : Math.min(loudGain, peakGain);
}

// ── The edit ───────────────────────────────────────────────────────────

/** Clamp edit params to a take of `durationSec`. Trim out ≥ trim in + one frame. */
export function clampEdit(p: TakeEditParams, durationSec: number): TakeEditParams {
  const tin = Math.min(Math.max(0, p.trimInSec), durationSec);
  const toutRaw = p.trimOutSec === null ? durationSec : Math.min(Math.max(tin, p.trimOutSec), durationSec);
  const len = toutRaw - tin;
  return {
    ...p,
    trimInSec: tin,
    trimOutSec: p.trimOutSec === null ? null : toutRaw,
    fadeInSec: Math.min(Math.max(0, p.fadeInSec), len),
    fadeOutSec: Math.min(Math.max(0, p.fadeOutSec), len),
  };
}

/** Render an edit of `source` into new channel arrays (the original is untouched). */
export function renderTakeEdit(
  source: { channels: ReadonlyArray<Float32Array>; sampleRate: number },
  params: TakeEditParams,
): Float32Array[] {
  const rate = source.sampleRate;
  const frames = source.channels[0]?.length ?? 0;
  const p = clampEdit(params, frames / rate);
  const start = Math.round(p.trimInSec * rate);
  const end = p.trimOutSec === null ? frames : Math.round(p.trimOutSec * rate);
  let ch = sliceChannels(source.channels, start, Math.max(start, end));
  if (p.highPass.enabled) ch = highPass(ch, p.highPass.hz, rate);
  if (p.gate.enabled) ch = noiseGate(ch, rate, p.gate);
  applyFades(ch, p.fadeInSec * rate, p.fadeOutSec * rate);
  applyGain(ch, normalizeGain(ch, rate, p.normalize, p.peakCeilingDb, p.loudnessTargetLufs) * dbToGain(p.gainDb));
  return ch;
}

// ── Waveform peaks ─────────────────────────────────────────────────────

/**
 * Min / max per bucket over all channels (the waveform view): `out[2b]` is
 * the bucket's min, `out[2b+1]` its max. `buckets` ≥ 1.
 */
export function computePeaks(channels: ReadonlyArray<Float32Array>, buckets: number): Float32Array {
  const n = channels[0]?.length ?? 0;
  const b = Math.max(1, Math.floor(buckets));
  const out = new Float32Array(b * 2);
  for (let k = 0; k < b; k++) {
    const s = Math.floor((k * n) / b);
    const e = Math.max(s + 1, Math.floor(((k + 1) * n) / b));
    let lo = 0;
    let hi = 0;
    for (const ch of channels) {
      for (let i = s; i < Math.min(e, n); i++) {
        const x = ch[i]!;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    }
    out[2 * k] = lo;
    out[2 * k + 1] = hi;
  }
  return out;
}

/**
 * Peaks folded in while recording: one min / max pair per `framesPerBucket`
 * frames, so a long take's waveform is drawn without decoding it again.
 * Grows by doubling (amortised; a push is not a per-frame allocation).
 */
export class PeakAccumulator {
  private data: Float32Array;
  private count = 0;
  private fill = 0;
  private lo = 0;
  private hi = 0;

  constructor(readonly framesPerBucket: number, initialBuckets = 1024) {
    this.data = new Float32Array(Math.max(2, initialBuckets * 2));
  }

  push(channels: ReadonlyArray<Float32Array>, frames = channels[0]?.length ?? 0): void {
    for (let i = 0; i < frames; i++) {
      for (const ch of channels) {
        const x = ch[i]!;
        if (x < this.lo) this.lo = x;
        if (x > this.hi) this.hi = x;
      }
      if (++this.fill >= this.framesPerBucket) this.flushBucket();
    }
  }

  private flushBucket(): void {
    if ((this.count + 1) * 2 > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[2 * this.count] = this.lo;
    this.data[2 * this.count + 1] = this.hi;
    this.count++;
    this.fill = 0;
    this.lo = 0;
    this.hi = 0;
  }

  /** The buckets so far (a partial last bucket included). */
  peaks(): Float32Array {
    const extra = this.fill > 0 ? 1 : 0;
    const out = new Float32Array((this.count + extra) * 2);
    out.set(this.data.subarray(0, this.count * 2));
    if (extra) {
      out[2 * this.count] = this.lo;
      out[2 * this.count + 1] = this.hi;
    }
    return out;
  }
}

/** Re-bucket a peak array (min/max pairs) to `buckets` pairs for drawing. */
export function resamplePeaks(peaks: Float32Array, buckets: number, from = 0, to = peaks.length / 2): Float32Array {
  const b = Math.max(1, Math.floor(buckets));
  const out = new Float32Array(b * 2);
  const span = Math.max(0, to - from);
  for (let k = 0; k < b; k++) {
    const s = Math.floor(from + (k * span) / b);
    const e = Math.max(s + 1, Math.floor(from + ((k + 1) * span) / b));
    let lo = 0;
    let hi = 0;
    for (let i = s; i < e && i * 2 + 1 < peaks.length; i++) {
      if (peaks[2 * i]! < lo) lo = peaks[2 * i]!;
      if (peaks[2 * i + 1]! > hi) hi = peaks[2 * i + 1]!;
    }
    out[2 * k] = lo;
    out[2 * k + 1] = hi;
  }
  return out;
}
