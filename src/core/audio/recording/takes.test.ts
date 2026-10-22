import { decodeWav } from './wav';
import { formatTakeTime, maxTakeFrames, nextTakeName, takeFileName, WavPartWriter } from './takes';

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

describe('WavPartWriter', () => {
  it('streams blocks into parts that decode to the same samples', () => {
    const w = new WavPartWriter(2, 48000, 'float32', 1024);
    const l = new Float32Array(3000).map((_, i) => Math.sin(i / 10) * 0.5);
    const r = new Float32Array(3000).map((_, i) => Math.cos(i / 7) * 0.25);
    for (let s = 0; s < 3000; s += 700) w.append([l.subarray(s, s + 700), r.subarray(s, s + 700)], Math.min(700, 3000 - s));
    const done = w.finish();
    expect(done.frames).toBe(3000);
    // Header + ceil(3000 / 1024) parts.
    expect(done.parts.length).toBe(1 + 3);
    const d = decodeWav(concat(done.parts));
    expect(Array.from(d.channels[0]!)).toEqual(Array.from(l));
    expect(Array.from(d.channels[1]!)).toEqual(Array.from(r));
    expect(done.peaks.length).toBeGreaterThan(0);
  });

  it('copies a mono block to both sides of a stereo take', () => {
    const w = new WavPartWriter(2, 8000, 'float32', 1024);
    w.append([Float32Array.from([0.5, -0.5])]);
    const d = decodeWav(concat(w.finish().parts));
    expect(Array.from(d.channels[1]!)).toEqual([0.5, -0.5]);
  });

  it('stops at its ceiling', () => {
    const w = new WavPartWriter(1, 8000, 'pcm24', 1024);
    Object.defineProperty(w, 'maxFrames', { value: 10 });
    expect(w.append([new Float32Array(25)])).toBe(10);
    expect(w.full).toBe(true);
    expect(w.append([new Float32Array(5)])).toBe(0);
    expect(w.finish().frames).toBe(10);
  });
});

describe('take helpers', () => {
  it('a WAV holds under 4 GiB; the soft cap is 4 h', () => {
    // Mono 24-bit at 48 kHz is 144 kB/s: the 4 h cap comes first.
    expect(maxTakeFrames(1, 48000, 'pcm24')).toBe(4 * 3600 * 48000);
    // Stereo float is 384 kB/s: the RIFF size field runs out at ~3.1 h.
    const f = maxTakeFrames(2, 48000, 'float32');
    expect(f).toBeLessThan(4 * 3600 * 48000);
    expect(f * 2 * 4).toBeLessThan(2 ** 32);
  });

  it('names the next take', () => {
    expect(nextTakeName([], 'Voice-over')).toBe('Voice-over 1');
    expect(nextTakeName(['Voice-over 1', 'voice-over 2'], 'Voice-over')).toBe('Voice-over 3');
  });

  it('makes a safe file name', () => {
    expect(takeFileName('Intro: take 2/3?')).toBe('Intro take 2 3.wav');
    expect(takeFileName('  ...  ')).toBe('Recording.wav');
  });

  it('formats the clock', () => {
    expect(formatTakeTime(0)).toBe('0:00.0');
    expect(formatTakeTime(65.43)).toBe('1:05.4');
    expect(formatTakeTime(3725.9)).toBe('1:02:05.9');
  });
});
