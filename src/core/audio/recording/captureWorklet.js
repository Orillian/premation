/* global AudioWorkletProcessor, registerProcessor, sampleRate */
/**
 * The Record Audio panel's capture processor (AudioWorklet, audio thread).
 *
 * Plain JavaScript, not TypeScript: it is loaded by URL into the audio
 * worklet scope (`audioWorklet.addModule`), so it must be a file the bundler
 * copies as-is — see captureWorkletUrl.ts.
 *
 * Two outputs on its port, both in the input's own float samples (lossless —
 * no MediaRecorder, no codec):
 *   { type: 'level', peaks: number[] }          max |sample| per channel, ~every 20 ms
 *   { type: 'chunk', channels: Float32Array[] } BLOCK_FRAMES frames per channel,
 *                                                only while recording (buffers transferred)
 * and two inputs:
 *   { type: 'record', on: boolean }  start / stop accumulating
 *   { type: 'flush' }                post the partial chunk now, then { type: 'flushed' }
 *
 * The chunk buffers are allocated once per chunk (≈ 11 per second at 48 kHz),
 * never per 128-frame quantum; level messages carry a small array.
 */

const BLOCK_FRAMES = 4096;

class PremationCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channelCount = Math.max(1, (options && options.processorOptions && options.processorOptions.channelCount) || 1);
    this.recording = false;
    this.fill = 0;
    this.buffers = this.freshBuffers();
    this.peaks = new Array(this.channelCount).fill(0);
    this.levelFrames = 0;
    this.levelEvery = Math.max(128, Math.round(sampleRate / 50));
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'record') {
        this.recording = !!m.on;
      } else if (m.type === 'flush') {
        this.postChunk();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }

  freshBuffers() {
    const out = [];
    for (let c = 0; c < this.channelCount; c++) out.push(new Float32Array(BLOCK_FRAMES));
    return out;
  }

  postChunk() {
    if (this.fill === 0) return;
    const channels = this.buffers.map((b) => (this.fill === BLOCK_FRAMES ? b : b.slice(0, this.fill)));
    this.port.postMessage({ type: 'chunk', channels }, channels.map((c) => c.buffer));
    this.buffers = this.freshBuffers();
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const frames = input && input[0] ? input[0].length : 128;
    for (let c = 0; c < this.channelCount; c++) {
      // A mono source into a stereo take: both sides carry it.
      const src = input && (input[c] || input[0]);
      if (!src) continue;
      let p = this.peaks[c];
      for (let i = 0; i < src.length; i++) {
        const a = src[i] < 0 ? -src[i] : src[i];
        if (a > p) p = a;
      }
      this.peaks[c] = p;
    }
    if (this.recording) {
      let done = 0;
      while (done < frames) {
        const n = Math.min(frames - done, BLOCK_FRAMES - this.fill);
        for (let c = 0; c < this.channelCount; c++) {
          const src = input && (input[c] || input[0]);
          const dst = this.buffers[c];
          if (src) dst.set(src.subarray(done, done + n), this.fill);
          else dst.fill(0, this.fill, this.fill + n);
        }
        this.fill += n;
        done += n;
        if (this.fill === BLOCK_FRAMES) this.postChunk();
      }
    }
    this.levelFrames += frames;
    if (this.levelFrames >= this.levelEvery) {
      this.port.postMessage({ type: 'level', peaks: this.peaks.slice() });
      for (let c = 0; c < this.channelCount; c++) this.peaks[c] = 0;
      this.levelFrames = 0;
    }
    return true;
  }
}

registerProcessor('premation-capture', PremationCaptureProcessor);
