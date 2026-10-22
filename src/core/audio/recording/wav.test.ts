import { decodeWav, encodePcmFrames, encodeWav, wavHeader } from './wav';

const tone = (n: number, f: number, rate: number, amp = 0.5): Float32Array => {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / rate);
  return x;
};

describe('WAV encode / decode', () => {
  it('writes a 44-byte PCM header with the right sizes', () => {
    const h = wavHeader(100, 2, 48000, 'pcm24');
    const v = new DataView(h.buffer);
    expect(h.length).toBe(44);
    expect(String.fromCharCode(...h.subarray(0, 4))).toBe('RIFF');
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint16(34, true)).toBe(24);
    expect(v.getUint32(40, true)).toBe(100 * 2 * 3);
    expect(v.getUint32(4, true)).toBe(36 + 600);
  });

  it('writes an IEEE-float header with a fact chunk', () => {
    const h = wavHeader(10, 1, 44100, 'float32');
    const v = new DataView(h.buffer);
    expect(v.getUint16(20, true)).toBe(3);
    expect(String.fromCharCode(...h.subarray(38, 42))).toBe('fact');
    expect(v.getUint32(46, true)).toBe(10);
    expect(String.fromCharCode(...h.subarray(50, 54))).toBe('data');
    expect(h.length).toBe(58);
  });

  it('round-trips float32 exactly, mono and stereo', () => {
    const l = tone(1000, 440, 48000);
    const r = tone(1000, 660, 48000, 0.25);
    const d = decodeWav(encodeWav([l, r], 48000, 'float32'));
    expect(d.format).toBe('float32');
    expect(d.sampleRate).toBe(48000);
    expect(d.channels).toHaveLength(2);
    expect(Array.from(d.channels[0]!)).toEqual(Array.from(l));
    expect(Array.from(d.channels[1]!)).toEqual(Array.from(r));
  });

  it('round-trips 24-bit within one LSB and clamps overs', () => {
    const x = Float32Array.from([0, 0.5, -0.5, 1, -1, 1.5, -2, 1e-7]);
    const d = decodeWav(encodeWav([x], 44100, 'pcm24'));
    expect(d.format).toBe('pcm24');
    const back = d.channels[0]!;
    for (let i = 0; i < 5; i++) expect(Math.abs(back[i]! - x[i]!)).toBeLessThan(1 / 8388607);
    expect(back[5]).toBe(1);
    expect(back[6]).toBe(-1);
  });

  it('is deterministic: the same samples give the same bytes', () => {
    const x = tone(512, 100, 48000);
    expect(encodePcmFrames([x], 'pcm24')).toEqual(encodePcmFrames([x], 'pcm24'));
  });

  it('encodes a window of a block (offset + frames)', () => {
    const x = Float32Array.from([0.1, 0.2, 0.3, 0.4]);
    expect(encodePcmFrames([x], 'float32', 1, 2)).toEqual(encodePcmFrames([x.slice(1, 3)], 'float32'));
  });

  it('refuses what is not a WAV', () => {
    expect(() => decodeWav(new Uint8Array([1, 2, 3]))).toThrow('not a WAV');
  });
});
