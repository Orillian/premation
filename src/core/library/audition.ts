/**
 * Auditioning library sounds — hearing one before it goes into the comp.
 *
 * One sound at a time, app-wide: starting another stops the first, and the
 * panel stops it when it unmounts or changes tab. A free sound plays its
 * synthesised samples through Web Audio; a premium sound streams its public
 * preview through an <audio> element (the full payload is the paid part).
 *
 * Progress is pushed to subscribers from rAF while something plays — the
 * waveform reads it into an SVG attribute through a ref, so playing never
 * re-renders React (the performance rule for anything per-frame).
 *
 * Editor-only: it never touches the document or the engine's audio.
 */

export interface AuditionState {
  /** The library id playing, or null. */
  id: string | null;
  /** 0..1 through the sound. */
  progress: number;
}

type Listener = (s: AuditionState) => void;

const listeners = new Set<Listener>();
let state: AuditionState = { id: null, progress: 0 };
let ctx: AudioContext | null = null;
let source: AudioBufferSourceNode | null = null;
let element: HTMLAudioElement | null = null;
let raf = 0;
let startedAt = 0;
let duration = 0;

function emit(next: AuditionState): void {
  state = next;
  for (const fn of listeners) fn(state);
}

function tick(): void {
  if (!state.id) return;
  let p: number;
  if (element) {
    const d = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : duration;
    p = d > 0 ? element.currentTime / d : 0;
  } else if (ctx) {
    p = duration > 0 ? (ctx.currentTime - startedAt) / duration : 1;
  } else {
    p = 1;
  }
  emit({ id: state.id, progress: Math.min(1, Math.max(0, p)) });
  raf = requestAnimationFrame(tick);
}

/** Stop whatever is playing. */
export function stopAudition(): void {
  cancelAnimationFrame(raf);
  if (source) {
    source.onended = null;
    try { source.stop(); } catch { /* already stopped */ }
    source.disconnect();
    source = null;
  }
  if (element) {
    element.onended = null;
    element.onerror = null;
    element.pause();
    element.removeAttribute('src');
    element.load();
    element = null;
  }
  if (state.id !== null) emit({ id: null, progress: 0 });
}

/** Play synthesised mono samples (a free sound). */
export function auditionSamples(id: string, samples: Float32Array, sampleRate: number): void {
  stopAudition();
  ctx ??= new AudioContext();
  void ctx.resume();
  const buffer = ctx.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples.slice(), 0);
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(ctx.destination);
  node.onended = () => { if (source === node) stopAudition(); };
  source = node;
  duration = buffer.duration;
  startedAt = ctx.currentTime;
  node.start();
  emit({ id, progress: 0 });
  raf = requestAnimationFrame(tick);
}

/** Stream a preview url (a premium sound). `fallbackDuration` covers a stream that reports none. */
export function auditionUrl(id: string, url: string, fallbackDuration: number, onError?: () => void): void {
  stopAudition();
  const el = new Audio();
  el.preload = 'auto';
  el.src = url;
  el.onended = () => { if (element === el) stopAudition(); };
  el.onerror = () => {
    if (element !== el) return;
    stopAudition();
    onError?.();
  };
  element = el;
  duration = fallbackDuration;
  emit({ id, progress: 0 });
  void el.play().catch(() => {
    if (element !== el) return;
    stopAudition();
    onError?.();
  });
  raf = requestAnimationFrame(tick);
}

export function auditionState(): AuditionState {
  return state;
}

export function subscribeAudition(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
