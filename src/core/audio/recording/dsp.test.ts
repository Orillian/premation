import {
  applyFades,
  computePeaks,
  dbToGain,
  DEFAULT_TAKE_EDIT,
  gainToDb,
  highPass,
  integratedLoudness,
  isIdentityEdit,
  noiseGate,
  normalizeGain,
  PeakAccumulator,
  peakOf,
  renderTakeEdit,
  resamplePeaks,
  type TakeEditParams,
} from './dsp';

const RATE = 48000;
const tone = (seconds: number, f: number, amp: number, rate = RATE): Float32Array => {
  const n = Math.round(seconds * rate);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / rate);
  return x;
};
const rms = (x: Float32Array, s = 0, e = x.length): number => {
  let a = 0;
  for (let i = s; i < e; i++) a += x[i]! * x[i]!;
  return Math.sqrt(a / Math.max(1, e - s));
};
const edit = (p: Partial<TakeEditParams>): TakeEditParams => ({ ...DEFAULT_TAKE_EDIT, ...p });

describe('dB helpers', () => {
  it('convert both ways', () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
    expect(dbToGain(-Infinity)).toBe(0);
    expect(gainToDb(1)).toBe(0);
    expect(gainToDb(0)).toBe(-Infinity);
  });
});

describe('high-pass', () => {
  it('removes rumble and keeps voice', () => {
    const low = tone(1, 20, 0.5);
    const voice = tone(1, 1000, 0.5);
    const lowOut = highPass([low], 80, RATE)[0]!;
    const voiceOut = highPass([voice], 80, RATE)[0]!;
    // Skip the filter's settling at the start.
    expect(rms(lowOut, RATE / 2)).toBeLessThan(rms(low, RATE / 2) * 0.1);
    expect(rms(voiceOut, RATE / 2) / rms(voice, RATE / 2)).toBeCloseTo(1, 2);
  });
});

describe('noise gate', () => {
  it('turns quiet passages down by the range and leaves loud ones', () => {
    const quiet = tone(0.5, 300, dbToGain(-60));
    const loud = tone(0.5, 300, dbToGain(-12));
    const x = new Float32Array(quiet.length + loud.length);
    x.set(quiet, 0);
    x.set(loud, quiet.length);
    const out = noiseGate([x], RATE, { thresholdDb: -40, rangeDb: -40, attackMs: 1, holdMs: 10, releaseMs: 50 })[0]!;
    const q = rms(out, RATE * 0.1, quiet.length) / rms(x, RATE * 0.1, quiet.length);
    const l = rms(out, quiet.length + RATE * 0.05, x.length) / rms(x, quiet.length + RATE * 0.05, x.length);
    expect(gainToDb(q)).toBeCloseTo(-40, 0);
    expect(l).toBeCloseTo(1, 3);
  });
});

describe('fades', () => {
  it('start and end at silence and leave the middle alone', () => {
    const x = new Float32Array(1000).fill(1);
    applyFades([x], 100, 200);
    expect(x[0]).toBe(0);
    expect(x[50]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(x[500]).toBe(1);
    expect(x[999]).toBe(0);
  });
});

describe('loudness', () => {
  it('measures a full-scale 1 kHz sine near −3 LUFS (BS.1770 reference)', () => {
    // A 0 dBFS 997 Hz sine on one channel reads −3.01 LUFS.
    expect(integratedLoudness([tone(3, 997, 1)], RATE)).toBeCloseTo(-3.01, 1);
  });
  it('is −Infinity for silence and for under 400 ms', () => {
    expect(integratedLoudness([new Float32Array(RATE)], RATE)).toBe(-Infinity);
    expect(integratedLoudness([tone(0.2, 1000, 0.5)], RATE)).toBe(-Infinity);
  });
  it('is the same at 44.1 kHz', () => {
    expect(integratedLoudness([tone(3, 997, 1, 44100)], 44100)).toBeCloseTo(-3.01, 1);
  });
});

describe('normalize', () => {
  const x = tone(2, 500, 0.1);
  it('peak → ceiling', () => {
    expect(peakOf([x]) * normalizeGain([x], RATE, 'peak', -1, -16)).toBeCloseTo(dbToGain(-1), 4);
  });
  it('loudness → target', () => {
    const g = normalizeGain([x], RATE, 'loudness', -1, -20);
    const y = x.map((s) => s * g);
    expect(integratedLoudness([y], RATE)).toBeCloseTo(-20, 1);
  });
  it('both: the loudness gain, but never past the ceiling', () => {
    const g = normalizeGain([x], RATE, 'both', -1, 0);
    expect(peakOf([x]) * g).toBeCloseTo(dbToGain(-1), 4);
  });
  it('leaves silence and off alone', () => {
    expect(normalizeGain([new Float32Array(100)], RATE, 'peak', -1, -16)).toBe(1);
    expect(normalizeGain([x], RATE, 'off', -1, -16)).toBe(1);
  });
});

describe('renderTakeEdit', () => {
  const src = { channels: [tone(2, 440, 0.5), tone(2, 220, 0.25)], sampleRate: RATE };

  it('trims, never touching the original', () => {
    const before = src.channels[0]!.slice();
    const out = renderTakeEdit(src, edit({ trimInSec: 0.5, trimOutSec: 1.5 }));
    expect(out).toHaveLength(2);
    expect(out[0]!.length).toBe(RATE);
    expect(out[0]![0]).toBe(src.channels[0]![RATE / 2]);
    expect(src.channels[0]).toEqual(before);
  });

  it('applies gain after normalize', () => {
    const out = renderTakeEdit(src, edit({ normalize: 'peak', peakCeilingDb: -1, gainDb: -6 }));
    expect(gainToDb(peakOf(out))).toBeCloseTo(-7, 2);
  });

  it('clamps an out-of-range trim and fades', () => {
    const out = renderTakeEdit(src, edit({ trimInSec: 1.9, trimOutSec: 99, fadeInSec: 5, fadeOutSec: 5 }));
    expect(out[0]!.length).toBe(Math.round(0.1 * RATE));
    expect(out[0]![0]).toBe(0);
  });

  it('is deterministic', () => {
    const p = edit({ highPass: { enabled: true, hz: 100 }, gate: { ...DEFAULT_TAKE_EDIT.gate, enabled: true }, normalize: 'both', fadeInSec: 0.1 });
    expect(renderTakeEdit(src, p)).toEqual(renderTakeEdit(src, p));
  });

  it('knows an untouched edit', () => {
    expect(isIdentityEdit(DEFAULT_TAKE_EDIT, 2)).toBe(true);
    expect(isIdentityEdit(edit({ trimOutSec: 2 }), 2)).toBe(true);
    expect(isIdentityEdit(edit({ gainDb: 1 }), 2)).toBe(false);
  });
});

describe('peaks', () => {
  it('min / max per bucket over all channels', () => {
    const p = computePeaks([Float32Array.from([0.1, -0.5, 0.2, 0.9]), Float32Array.from([-0.7, 0, 0, 0])], 2);
    expect(Array.from(p)).toEqual([Math.fround(-0.7), Math.fround(0.1), 0, Math.fround(0.9)]);
  });

  it('the accumulator matches computePeaks for whole buckets', () => {
    const x = tone(0.1, 300, 0.8);
    const acc = new PeakAccumulator(100, 2);
    acc.push([x.subarray(0, 1234)]);
    acc.push([x.subarray(1234)]);
    const got = acc.peaks();
    expect(got.length).toBe(Math.ceil(x.length / 100) * 2);
    expect(got[1]).toBe(computePeaks([x.subarray(0, 100)], 1)[1]);
  });

  it('resamples to fewer buckets keeping the extremes', () => {
    const p = Float32Array.from([-0.1, 0.1, -0.9, 0.2, -0.3, 0.8, 0, 0]);
    expect(Array.from(resamplePeaks(p, 2))).toEqual([Math.fround(-0.9), Math.fround(0.2), Math.fround(-0.3), Math.fround(0.8)]);
  });
});
