/**
 * Live performance input from the page (docs/PERFORMANCE_ANIMATION_PLAN.md P1;
 * schema 97_live.eapi). The engine runs the camera and the hand model in a
 * child process and relays each tracked frame as a `liveInput` event; this
 * module turns those into
 *
 *   * `onLiveFrame(cb)` — every frame, for code that drives values from hands
 *     (the Performance bar's hand source). Plain callbacks: no React render
 *     per frame (CLAUDE.md performance discipline);
 *   * `useLiveInputStore` — the status the UI shows, updated on a state
 *     change and otherwise at most 4×/s.
 *
 * Editor input, like the pointer: nothing here writes the document.
 */

import type { CameraInfo, EventBatch, LiveHand, LiveInputEvent } from '@motion/engine-api';
import { engine, subscribeEngine } from '@core/engine/engineInstance';
import { useLiveInputStore } from '@stores/liveInputStore';

export interface LiveFrame {
  seq: number;
  /** Sensor capture → landmarks ready, ms (0 when unknown). */
  latencyMs: number;
  /** Camera frame size the landmarks are normalized to. */
  width: number;
  height: number;
  hands: readonly LiveHand[];
}

export type LiveFrameListener = (frame: LiveFrame) => void;

export interface StartLiveOptions {
  /** A camera id from listLiveCameras; '' = the first colour camera. */
  camera?: string;
  /** Hands to follow (1–2). */
  maxHands?: number;
}

const frameListeners = new Set<LiveFrameListener>();
let latest: LiveFrame | null = null;
let installed = false;

// Readout pacing (the store, not the frames).
const READOUT_MS = 250;
let lastReadout = 0;
let framesSinceReadout = 0;

const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** One `liveInput` event: status into the store, a frame to the listeners. */
export function applyLiveInputEvent(e: Pick<LiveInputEvent, 'state' | 'message' | 'camera' | 'width' | 'height' | 'fps' | 'seq' | 'latencyMs' | 'hands'>): void {
  const s = useLiveInputStore.getState();
  const changed = s.state !== e.state || s.message !== e.message || (e.state === 'running' && e.camera !== '' && s.camera !== e.camera);
  if (e.state === 'running' && e.seq > 0) {
    latest = { seq: Number(e.seq), latencyMs: e.latencyMs, width: e.width || s.width, height: e.height || s.height, hands: e.hands };
    framesSinceReadout++;
    for (const l of [...frameListeners]) {
      try {
        l(latest);
      } catch {
        // A listener's bug must not stop the others or the stream.
      }
    }
  }
  if (e.state !== 'running') latest = null;
  const t = nowMs();
  if (changed || t - lastReadout >= READOUT_MS) {
    const dt = t - lastReadout;
    useLiveInputStore.setState({
      state: e.state,
      message: e.message,
      ...(e.camera ? { camera: e.camera } : {}),
      ...(e.width ? { width: e.width, height: e.height } : {}),
      ...(e.fps ? { fps: e.fps } : {}),
      trackedFps: e.state === 'running' && lastReadout > 0 && dt > 0 ? Math.round((framesSinceReadout * 1000) / dt) : 0,
      latencyMs: e.state === 'running' ? Math.round(e.latencyMs) : 0,
      hands: e.state === 'running' ? e.hands.length : 0,
    });
    lastReadout = t;
    framesSinceReadout = 0;
  }
}

function onBatch(b: EventBatch): void {
  for (const e of b.events) {
    if (e.type === 'liveInput') applyLiveInputEvent(e);
  }
}

/** Listen to the engine's live events (once; survives engine restarts — subscribeEngine does). */
function install(): void {
  if (installed) return;
  installed = true;
  subscribeEngine(onBatch);
}

/** Every tracked frame while live input runs. Returns the unsubscribe. */
export function onLiveFrame(listener: LiveFrameListener): () => void {
  install();
  frameListeners.add(listener);
  return () => frameListeners.delete(listener);
}

/** The newest frame, or null when live input is not running. */
export function latestLiveFrame(): LiveFrame | null {
  return latest;
}

/**
 * Start live input. Resolves null when the engine accepted (the outcome then
 * arrives as status: running, or failed with the reason), else the refusal.
 */
export async function startLiveInput(opts: StartLiveOptions = {}): Promise<string | null> {
  install();
  const res = await engine().execute({
    type: 'startLiveInput',
    camera: opts.camera ?? '',
    modelDir: '',
    width: 640,
    fps: 60,
    maxHands: Math.min(2, Math.max(1, opts.maxHands ?? 2)),
  });
  if (res.ok) return null;
  const message = res.error.code === 'unsupported' ? 'Live input needs the desktop app.' : res.error.message;
  useLiveInputStore.setState({ state: 'failed', message });
  return message;
}

/** Stop live input and release the camera. */
export async function stopLiveInput(): Promise<void> {
  install();
  await engine().execute({ type: 'stopLiveInput' });
}

/** The cameras the engine can open, or the reason it cannot list them. */
export async function listLiveCameras(): Promise<{ cameras: CameraInfo[] } | { error: string }> {
  const res = await engine().query({ type: 'listCameras' });
  return res.ok ? { cameras: res.value.cameras } : { error: res.error.message };
}

/** Tests: forget listeners and the last frame. */
export function resetLiveInputForTests(): void {
  frameListeners.clear();
  latest = null;
  lastReadout = 0;
  framesSinceReadout = 0;
  useLiveInputStore.setState({ state: 'stopped', message: '', camera: '', width: 0, height: 0, fps: 0, trackedFps: 0, latencyMs: 0, hands: 0 });
}
