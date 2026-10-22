/**
 * Recorded takes, framework-free: the chunked WAV writer the capture feeds,
 * take names and file names, the longest take a WAV can hold, and the clock
 * readout.
 *
 * `WavPartWriter` is why a one-hour take does not sit in memory as one
 * Float32Array (or worse, in React state): captured blocks are encoded to
 * the take's sample format as they arrive and kept as ~2 s byte parts, which
 * the caller turns into a Blob (Chromium spills large Blobs to disk).
 */

import { bytesPerSample, encodePcmFrames, wavHeader, WAV_MAX_DATA_BYTES, type WavSampleFormat } from './wav';
import { PeakAccumulator } from './dsp';

/** Frames per waveform bucket kept while recording (≈ 5 ms at 48 kHz). */
export const PEAK_FRAMES_PER_BUCKET = 256;

/** A soft ceiling on one take, seconds (4 h) — far past any voice-over, short of the WAV limit. */
export const MAX_TAKE_SECONDS = 4 * 60 * 60;

/** The most frames one take may hold: the WAV 4 GiB limit, or MAX_TAKE_SECONDS. */
export function maxTakeFrames(channelCount: number, sampleRate: number, format: WavSampleFormat): number {
  const byWav = Math.floor(WAV_MAX_DATA_BYTES / (Math.max(1, channelCount) * bytesPerSample(format)));
  return Math.min(byWav, Math.floor(MAX_TAKE_SECONDS * sampleRate));
}

export interface FinishedTake {
  /** Header first, then the PCM parts — `new Blob(parts, { type: 'audio/wav' })`. */
  parts: Uint8Array[];
  frames: number;
  peaks: Float32Array;
}

export class WavPartWriter {
  private readonly pending: Float32Array[];
  private pendingFrames = 0;
  private readonly parts: Uint8Array[] = [];
  private total = 0;
  private readonly peaks = new PeakAccumulator(PEAK_FRAMES_PER_BUCKET);
  readonly maxFrames: number;

  constructor(
    readonly channelCount: number,
    readonly sampleRate: number,
    readonly format: WavSampleFormat,
    readonly partFrames = Math.max(1024, Math.round(sampleRate * 2)),
  ) {
    this.pending = Array.from({ length: channelCount }, () => new Float32Array(this.partFrames));
    this.maxFrames = maxTakeFrames(channelCount, sampleRate, format);
  }

  /** Frames written so far. */
  get frames(): number {
    return this.total;
  }

  /** Whether the take has reached its ceiling (the caller stops). */
  get full(): boolean {
    return this.total >= this.maxFrames;
  }

  /**
   * Append one captured block (planar; a missing channel is silence — a mono
   * block into a stereo take is copied to both sides). Frames past the
   * ceiling are dropped. Returns the frames actually taken.
   */
  append(block: ReadonlyArray<Float32Array>, frames = block[0]?.length ?? 0): number {
    const take = Math.max(0, Math.min(frames, this.maxFrames - this.total));
    let done = 0;
    while (done < take) {
      const room = this.partFrames - this.pendingFrames;
      const n = Math.min(room, take - done);
      for (let c = 0; c < this.channelCount; c++) {
        const src = block[c] ?? block[0];
        const dst = this.pending[c]!;
        if (src) dst.set(src.subarray(done, done + n), this.pendingFrames);
        else dst.fill(0, this.pendingFrames, this.pendingFrames + n);
      }
      this.pendingFrames += n;
      done += n;
      if (this.pendingFrames >= this.partFrames) this.flush();
    }
    this.total += take;
    return take;
  }

  private flush(): void {
    if (this.pendingFrames === 0) return;
    this.peaks.push(this.pending, this.pendingFrames);
    this.parts.push(encodePcmFrames(this.pending, this.format, 0, this.pendingFrames));
    this.pendingFrames = 0;
  }

  /** Close the take: header + parts, the frame count and the waveform peaks. */
  finish(): FinishedTake {
    this.flush();
    return {
      parts: [wavHeader(this.total, this.channelCount, this.sampleRate, this.format), ...this.parts],
      frames: this.total,
      peaks: this.peaks.peaks(),
    };
  }
}

/** "<base> N" with the first N not already used (1-based). */
export function nextTakeName(existing: ReadonlyArray<string>, base: string): string {
  const used = new Set(existing.map((n) => n.trim().toLowerCase()));
  for (let i = 1; ; i++) {
    const name = `${base} ${i}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

/** A take's file name in the project: the name, filesystem-safe, `.wav`. */
export function takeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what a file name must not carry
  const safe = name.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return `${safe.slice(0, 80) || 'Recording'}.wav`;
}

/** Elapsed time as m:ss.t (or h:mm:ss.t past an hour). */
export function formatTakeTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const tenths = Math.floor(s * 10) % 10;
  const whole = Math.floor(s);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const sec = whole % 60;
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}.${tenths}` : `${m}:${ss}.${tenths}`;
}
