/**
 * The Record Audio panel's controller: one per mounted panel, plain class,
 * no React. It owns the microphone session, the take being written and the
 * meter state, and reports phase changes as `RecorderEvent`s to the panel's
 * reducer (core/audio/recording/recorderMachine.ts).
 *
 * Nothing here renders per audio block: level messages fold into the mutable
 * `meter` (read by the meter's rAF loop), chunks go straight into a
 * `WavPartWriter` (encoded parts, not one growing array), and the elapsed
 * clock is `elapsedSec()`, also read from rAF. React hears about a take only
 * when it is finished (`onTake`).
 *
 * The transport is driven through the timeline's own API
 * (`playTransport` / `pauseTransport`), and the take's start is the playhead
 * the moment capture begins — after a count-in, after play has started.
 */

import { CaptureSession, type CaptureOptions } from '@core/audio/recording/captureSession';
import { createMeter, resetClip, updateMeter, type MeterState } from '@core/audio/recording/meter';
import { captureErrorKind, type RecorderEvent } from '@core/audio/recording/recorderMachine';
import { PEAK_FRAMES_PER_BUCKET, WavPartWriter } from '@core/audio/recording/takes';
import type { WavSampleFormat } from '@core/audio/recording/wav';
import { pauseTransport, playheadSeconds, playTransport } from '@core/timeline/timelineView';

export interface FinishedTakeData {
  blob: Blob;
  peaks: Float32Array;
  framesPerBucket: number;
  durationSec: number;
  sampleRate: number;
  channelCount: number;
  format: WavSampleFormat;
  startSec: number;
  partial: boolean;
}

export interface RecordSettings extends CaptureOptions {
  countIn: boolean;
  playWhileRecording: boolean;
  format: WavSampleFormat;
}

export interface ControllerHost {
  dispatch(e: RecorderEvent): void;
  settings(): RecordSettings;
  onTake(take: FinishedTakeData): void;
  /** The chosen device could not be opened and the default was used instead. */
  onFellBackToDefault?(): void;
}

/** The OS microphone switch (desktop): resolves false when it is off. */
async function osAllowsMicrophone(): Promise<boolean> {
  const media = typeof window !== 'undefined' ? window.motionEditor?.media : undefined;
  if (!media?.microphoneStatus) return true;
  try {
    let status = await media.microphoneStatus();
    if (status === 'not-determined' && media.requestMicrophone) status = await media.requestMicrophone();
    return status !== 'denied' && status !== 'restricted';
  } catch {
    return true;
  }
}

const COUNT_IN_SECONDS = 3;

export class RecordController {
  /** Live meter state — mutated in place, read by the meter's rAF loop. */
  meter: MeterState = createMeter(1);
  private session: CaptureSession | null = null;
  private writer: WavPartWriter | null = null;
  private startSec = 0;
  private playing = false;
  private countTimer: ReturnType<typeof setInterval> | null = null;
  private finishing: Promise<void> | null = null;
  private disposed = false;
  private openSeq = 0;

  constructor(private readonly host: ControllerHost) {}

  /** The open input's facts (null when closed). */
  get input(): { channelCount: number; sampleRate: number; deviceId: string | null; label: string } | null {
    const s = this.session;
    return s ? { channelCount: s.channelCount, sampleRate: s.sampleRate, deviceId: s.deviceId, label: s.deviceLabel } : null;
  }

  /** Seconds in the take being recorded (0 when none). */
  elapsedSec(): number {
    const w = this.writer;
    return w ? w.frames / w.sampleRate : 0;
  }

  /** Open the microphone with the current settings. */
  async open(): Promise<void> {
    if (this.session || this.disposed) return;
    const seq = ++this.openSeq;
    this.host.dispatch({ type: 'open' });
    if (!(await osAllowsMicrophone())) {
      this.host.dispatch({ type: 'openFailed', kind: 'osDenied' });
      return;
    }
    const s = this.host.settings();
    let session: CaptureSession;
    try {
      session = await this.openSession(s);
    } catch (err) {
      const kind = captureErrorKind(err);
      // The remembered device is gone: fall back to the default input once.
      if (kind === 'noDevice' && s.deviceId) {
        try {
          session = await this.openSession({ ...s, deviceId: null });
          this.host.onFellBackToDefault?.();
        } catch (err2) {
          if (seq === this.openSeq) this.host.dispatch({ type: 'openFailed', kind: captureErrorKind(err2), detail: (err2 as Error)?.message });
          return;
        }
      } else {
        if (seq === this.openSeq) this.host.dispatch({ type: 'openFailed', kind, detail: (err as Error)?.message });
        return;
      }
    }
    // Closed or re-opened while the prompt was up.
    if (this.disposed || seq !== this.openSeq) {
      void session.close();
      return;
    }
    this.session = session;
    this.meter = createMeter(session.channelCount);
    this.host.dispatch({ type: 'opened' });
  }

  private openSession(opts: CaptureOptions): Promise<CaptureSession> {
    return CaptureSession.open(opts, {
      onLevel: (peaks) => updateMeter(this.meter, peaks, performance.now()),
      onChunk: (channels) => this.onChunk(channels),
      onEnded: () => { void this.onDeviceLost(); },
    });
  }

  /** Close the microphone (a take in progress is finished and kept first). */
  async close(): Promise<void> {
    this.openSeq++;
    this.clearCountIn();
    if (this.writer) await this.stop();
    if (this.finishing) await this.finishing;
    const s = this.session;
    this.session = null;
    if (s) await s.close();
    this.host.dispatch({ type: 'close' });
  }

  /** Re-open with new device / processing settings (between takes only). */
  async reopen(): Promise<void> {
    if (this.writer || this.countTimer) return;
    const s = this.session;
    this.session = null;
    this.host.dispatch({ type: 'close' });
    if (s) await s.close();
    await this.open();
  }

  setInputGainDb(db: number): void {
    this.session?.setInputGainDb(db);
  }

  resetClip(): void {
    resetClip(this.meter);
  }

  /** Record: count in (if set), then capture from the playhead. */
  record(): void {
    if (!this.session || this.writer || this.countTimer) return;
    const s = this.host.settings();
    const count = s.countIn ? COUNT_IN_SECONDS : 0;
    this.host.dispatch({ type: 'record', countIn: count });
    if (count === 0) {
      this.beginCapture(s);
      return;
    }
    let left = count;
    this.countTimer = setInterval(() => {
      left--;
      this.host.dispatch({ type: 'tick' });
      if (left <= 0) {
        this.clearCountIn();
        this.beginCapture(this.host.settings());
      }
    }, 1000);
  }

  private clearCountIn(): void {
    if (this.countTimer) clearInterval(this.countTimer);
    this.countTimer = null;
  }

  private beginCapture(s: RecordSettings): void {
    const session = this.session;
    if (!session) return;
    this.playing = s.playWhileRecording;
    if (this.playing) playTransport();
    // After play: playTransport rewinds a playhead parked at the end.
    this.startSec = playheadSeconds();
    this.writer = new WavPartWriter(session.channelCount, session.sampleRate, s.format);
    session.setRecording(true);
  }

  pause(): void {
    if (!this.writer || !this.session) return;
    this.session.setRecording(false);
    if (this.playing) pauseTransport();
    this.host.dispatch({ type: 'pause' });
  }

  resume(): void {
    if (!this.writer || !this.session) return;
    if (this.playing) playTransport();
    this.session.setRecording(true);
    this.host.dispatch({ type: 'resume' });
  }

  /** Stop: cancels a count-in, or finishes the take. */
  async stop(): Promise<void> {
    if (this.countTimer) {
      this.clearCountIn();
      this.host.dispatch({ type: 'stop' });
      return;
    }
    if (!this.writer) return;
    this.host.dispatch({ type: 'stop' });
    await this.finishTake(false);
  }

  private onChunk(channels: Float32Array[]): void {
    const w = this.writer;
    if (!w) return;
    w.append(channels);
    if (w.full && !this.finishing) {
      this.host.dispatch({ type: 'limitReached' });
      void this.finishTake(true);
    }
  }

  private async onDeviceLost(): Promise<void> {
    this.clearCountIn();
    this.host.dispatch({ type: 'deviceLost' });
    if (this.writer) await this.finishTake(true);
    const s = this.session;
    this.session = null;
    if (s) await s.close();
    this.host.dispatch({ type: 'close' });
  }

  private finishTake(partial: boolean): Promise<void> {
    if (this.finishing) return this.finishing;
    this.finishing = (async () => {
      const session = this.session;
      session?.setRecording(false);
      if (this.playing) pauseTransport();
      this.playing = false;
      if (session) await session.flush();
      const w = this.writer;
      this.writer = null;
      if (w && w.frames > 0) {
        const done = w.finish();
        this.host.onTake({
          blob: new Blob(done.parts as BlobPart[], { type: 'audio/wav' }),
          peaks: done.peaks,
          framesPerBucket: PEAK_FRAMES_PER_BUCKET,
          durationSec: done.frames / w.sampleRate,
          sampleRate: w.sampleRate,
          channelCount: w.channelCount,
          format: w.format,
          startSec: this.startSec,
          partial,
        });
      }
      this.host.dispatch({ type: 'finished' });
    })().finally(() => { this.finishing = null; });
    return this.finishing;
  }

  /** The panel unmounted: keep what was recorded, release the microphone. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.close();
    this.disposed = true;
  }
}
