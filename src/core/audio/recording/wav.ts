/**
 * WAV for recorded audio (Record Audio panel): 24-bit integer PCM or 32-bit
 * IEEE float, mono or stereo, any sample rate — written in PARTS so a long
 * take is never one giant array.
 *
 *   wavHeader(...)        the RIFF/fmt/(fact)/data header for a known length
 *   encodePcmFrames(...)  interleave + encode one block of planar samples
 *   encodeWav(...)        header + one block (tests, short renders)
 *   decodeWav(...)        back to planar Float32 (16/24/32-bit int, 32-bit float,
 *                         WAVE_FORMAT_EXTENSIBLE) — the edit step reads takes here
 *
 * Framework-free and deterministic: the same samples always encode to the
 * same bytes (24-bit rounds half away from zero, clamps to ±1).
 */

export type WavSampleFormat = 'pcm24' | 'float32';

export interface DecodedWav {
  sampleRate: number;
  /** Planar channel data, one Float32Array per channel. */
  channels: Float32Array[];
  format: WavSampleFormat | 'pcm16' | 'pcm32';
}

/** Bytes per sample for a format. */
export function bytesPerSample(format: WavSampleFormat): number {
  return format === 'pcm24' ? 3 : 4;
}

/** The RIFF size field is 32-bit: the most data bytes a single WAV may carry. */
export const WAV_MAX_DATA_BYTES = 0xffffffff - 64;

/** The header for `frames` frames. 44 bytes for PCM; 58 for float (fmt cbSize + fact). */
export function wavHeader(frames: number, channelCount: number, sampleRate: number, format: WavSampleFormat): Uint8Array {
  const bps = bytesPerSample(format);
  const dataLen = frames * channelCount * bps;
  const isFloat = format === 'float32';
  const fmtLen = isFloat ? 18 : 16;
  const factLen = isFloat ? 12 : 0;
  const headerLen = 12 + 8 + fmtLen + factLen + 8;
  const buf = new ArrayBuffer(headerLen);
  const v = new DataView(buf);
  const str = (off: number, s: string): void => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, headerLen - 8 + dataLen, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, fmtLen, true);
  v.setUint16(20, isFloat ? 3 : 1, true);
  v.setUint16(22, channelCount, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channelCount * bps, true);
  v.setUint16(32, channelCount * bps, true);
  v.setUint16(34, bps * 8, true);
  let off = 36;
  if (isFloat) {
    v.setUint16(off, 0, true); // cbSize
    off += 2;
    str(off, 'fact');
    v.setUint32(off + 4, 4, true);
    v.setUint32(off + 8, frames, true);
    off += 12;
  }
  str(off, 'data');
  v.setUint32(off + 4, dataLen, true);
  return new Uint8Array(buf);
}

/**
 * Interleave and encode `frames` frames of planar samples starting at
 * `offset` in every channel. `channels.length` is the channel count.
 */
export function encodePcmFrames(
  channels: ReadonlyArray<Float32Array>,
  format: WavSampleFormat,
  offset = 0,
  frames = (channels[0]?.length ?? 0) - offset,
): Uint8Array {
  const n = Math.max(0, frames);
  const cc = channels.length;
  const bps = bytesPerSample(format);
  const out = new Uint8Array(n * cc * bps);
  if (format === 'float32') {
    const v = new DataView(out.buffer);
    let o = 0;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < cc; c++) {
        v.setFloat32(o, channels[c]![offset + i] ?? 0, true);
        o += 4;
      }
    }
    return out;
  }
  let o = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < cc; c++) {
      const s = channels[c]![offset + i] ?? 0;
      const x = s >= 1 ? 1 : s <= -1 ? -1 : s;
      // 24-bit: −8388608 … 8388607. Round half away from zero (deterministic).
      let q = x < 0 ? -Math.round(-x * 8388608) : Math.round(x * 8388607);
      if (q < -8388608) q = -8388608;
      if (q > 8388607) q = 8388607;
      out[o] = q & 0xff;
      out[o + 1] = (q >> 8) & 0xff;
      out[o + 2] = (q >> 16) & 0xff;
      o += 3;
    }
  }
  return out;
}

/** A whole WAV file in one buffer (short renders and tests). */
export function encodeWav(channels: ReadonlyArray<Float32Array>, sampleRate: number, format: WavSampleFormat): Uint8Array {
  const frames = channels[0]?.length ?? 0;
  const head = wavHeader(frames, channels.length, sampleRate, format);
  const body = encodePcmFrames(channels, format);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/** Decode a WAV file to planar float. Throws on anything that is not a WAV this module can read. */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number): string => String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
  if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12;
  let fmt: { code: number; channels: number; rate: number; bits: number } | null = null;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= bytes.byteLength) {
    const id = tag(off);
    const len = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      let code = v.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE: the real code is the sub-format GUID's first two bytes.
      if (code === 0xfffe && len >= 26) code = v.getUint16(body + 24, true);
      fmt = { code, channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    } else if (id === 'data') {
      dataOff = body;
      dataLen = Math.min(len, bytes.byteLength - body);
      break;
    }
    off = body + len + (len & 1);
  }
  if (!fmt || dataOff < 0) throw new Error('WAV has no fmt or data chunk');
  const { code, channels: cc, rate, bits } = fmt;
  const bps = bits / 8;
  if (cc < 1 || !Number.isInteger(bps) || bps < 2) throw new Error('unsupported WAV layout');
  const frames = Math.floor(dataLen / (cc * bps));
  const channels = Array.from({ length: cc }, () => new Float32Array(frames));
  let format: DecodedWav['format'];
  let p = dataOff;
  if (code === 3 && bits === 32) {
    format = 'float32';
    for (let i = 0; i < frames; i++) for (let c = 0; c < cc; c++) { channels[c]![i] = v.getFloat32(p, true); p += 4; }
  } else if (code === 1 && bits === 16) {
    format = 'pcm16';
    for (let i = 0; i < frames; i++) for (let c = 0; c < cc; c++) { channels[c]![i] = v.getInt16(p, true) / 32768; p += 2; }
  } else if (code === 1 && bits === 24) {
    format = 'pcm24';
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < cc; c++) {
        let q = bytes[p]! | (bytes[p + 1]! << 8) | (bytes[p + 2]! << 16);
        if (q & 0x800000) q |= ~0xffffff;
        channels[c]![i] = q < 0 ? q / 8388608 : q / 8388607;
        p += 3;
      }
    }
  } else if (code === 1 && bits === 32) {
    format = 'pcm32';
    for (let i = 0; i < frames; i++) for (let c = 0; c < cc; c++) { channels[c]![i] = v.getInt32(p, true) / 2147483648; p += 4; }
  } else {
    throw new Error(`unsupported WAV encoding (format ${code}, ${bits}-bit)`);
  }
  return { sampleRate: rate, channels, format };
}
