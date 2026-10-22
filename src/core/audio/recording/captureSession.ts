/**
 * The microphone, opened for the Record Audio panel: getUserMedia (audio
 * only) → input gain → the capture AudioWorklet (captureWorklet.js), at the
 * AudioContext's own sample rate, mono or stereo as the device delivers.
 *
 * Browser APIs only — no React, no stores. The panel's controller owns the
 * session and decides what the levels and chunks become (the meter, a
 * `WavPartWriter`).
 *
 * The worklet's output is wired into a muted gain to the destination: an
 * AudioWorkletNode nothing pulls from is not guaranteed to run, and the
 * microphone must never be monitored through the speakers here (feedback).
 */

import { captureWorkletUrl } from './captureWorkletUrl';
import { dbToGain } from './dsp';

export interface CaptureOptions {
  /** A `MediaDeviceInfo.deviceId`; null = the system default input. */
  deviceId: string | null;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  /** Input gain before capture, dB. */
  inputGainDb: number;
}

export interface CaptureCallbacks {
  /** Max |sample| per channel since the last call (~50 per second). */
  onLevel(peaks: ReadonlyArray<number>): void;
  /** One captured block, planar, while recording. */
  onChunk(channels: Float32Array[]): void;
  /** The input track ended (device unplugged, permission revoked). */
  onEnded(): void;
}

export interface InputDevice {
  id: string;
  label: string;
}

/** A named error the reducer can classify (`captureErrorKind`). */
function namedError(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

/** Whether this runtime can record at all. */
export function captureSupported(): boolean {
  return typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof AudioContext !== 'undefined'
    && typeof AudioWorkletNode !== 'undefined';
}

/** The audio inputs (labels are empty until the page has been granted the mic once). */
export async function listInputDevices(): Promise<InputDevice[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications')
    .map((d) => ({ id: d.deviceId, label: d.label }));
}

export class CaptureSession {
  private closed = false;
  private flushWaiters: Array<() => void> = [];

  private constructor(
    private readonly ctx: AudioContext,
    private readonly stream: MediaStream,
    private readonly source: MediaStreamAudioSourceNode,
    private readonly gain: GainNode,
    private readonly node: AudioWorkletNode,
    private readonly sink: GainNode,
    readonly channelCount: number,
    readonly deviceId: string | null,
    readonly deviceLabel: string,
  ) {}

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  /** Open the input. Rejects with a DOMException-named error (see `captureErrorKind`). */
  static async open(opts: CaptureOptions, cb: CaptureCallbacks): Promise<CaptureSession> {
    if (!captureSupported()) throw namedError('UnsupportedError', 'audio capture is not available in this runtime');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
        echoCancellation: opts.echoCancellation,
        noiseSuppression: opts.noiseSuppression,
        autoGainControl: opts.autoGainControl,
        channelCount: { ideal: 2 },
      },
      video: false,
    });
    const track = stream.getAudioTracks()[0];
    if (!track) {
      for (const t of stream.getTracks()) t.stop();
      throw namedError('NotFoundError', 'the input has no audio track');
    }
    const settings = track.getSettings();
    const channelCount = Math.min(2, Math.max(1, settings.channelCount ?? 1));
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext({ latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule(captureWorkletUrl());
      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      gain.gain.value = dbToGain(opts.inputGainDb);
      const node = new AudioWorkletNode(ctx, 'premation-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount,
        channelCountMode: 'explicit',
        // Discrete: a stereo device's two channels stay two; a mono one is
        // not up-mixed by the graph (the worklet copies it to both sides
        // only if the take is stereo).
        channelInterpretation: 'discrete',
        processorOptions: { channelCount },
      });
      const sink = ctx.createGain();
      sink.gain.value = 0;
      source.connect(gain).connect(node).connect(sink).connect(ctx.destination);
      const session = new CaptureSession(ctx, stream, source, gain, node, sink, channelCount, settings.deviceId ?? opts.deviceId, track.label);
      node.port.onmessage = (e: MessageEvent) => {
        const m = e.data as { type: string; peaks?: number[]; channels?: Float32Array[] };
        if (m.type === 'level' && m.peaks) cb.onLevel(m.peaks);
        // Every chunk counts: the worklet only makes them while recording, and
        // one posted just before a pause / stop is audio the user recorded.
        else if (m.type === 'chunk' && m.channels) cb.onChunk(m.channels);
        else if (m.type === 'flushed') session.flushWaiters.splice(0).forEach((f) => f());
      };
      track.addEventListener('ended', () => { if (!session.closed) cb.onEnded(); });
      if (ctx.state === 'suspended') await ctx.resume();
      return session;
    } catch (err) {
      for (const t of stream.getTracks()) t.stop();
      if (ctx) void ctx.close().catch(() => undefined);
      throw err;
    }
  }

  setInputGainDb(db: number): void {
    this.gain.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.01);
  }

  /** Start / stop accumulating chunks (the meter runs either way). */
  setRecording(on: boolean): void {
    this.node.port.postMessage({ type: 'record', on });
  }

  /**
   * Post the worklet's partial chunk (call after `setRecording(false)`);
   * resolves once it — and every chunk before it, the port is ordered — has
   * arrived.
   */
  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => resolve();
      this.flushWaiters.push(done);
      this.node.port.postMessage({ type: 'flush' });
      // A context that stopped (device gone) never answers: give up after 500 ms.
      setTimeout(() => {
        const i = this.flushWaiters.indexOf(done);
        if (i >= 0) {
          this.flushWaiters.splice(i, 1);
          done();
        }
      }, 500);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.flushWaiters.splice(0).forEach((f) => f());
    try {
      this.source.disconnect();
      this.gain.disconnect();
      this.node.disconnect();
      this.sink.disconnect();
      this.node.port.onmessage = null;
    } catch {
      /* already torn down */
    }
    for (const t of this.stream.getTracks()) t.stop();
    await this.ctx.close().catch(() => undefined);
  }
}
