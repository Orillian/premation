/**
 * Live performance input's STATUS for the UI (docs/PERFORMANCE_ANIMATION_PLAN.md
 * P1): stopped / starting / running / failed, the camera, and a few readouts.
 * Editor state, never the document.
 *
 * Not the hands: they arrive at the camera's rate and go to
 * `core/live/liveInput.onLiveFrame` subscribers (no React render per frame).
 * The readouts here (rate, latency, hands seen) change at most 4×/s.
 */

import { create } from 'zustand';
import type { LiveInputState } from '@motion/engine-api';

export interface LiveInputStatus {
  state: LiveInputState;
  /** `failed`: the reason, for the user. */
  message: string;
  camera: string;
  width: number;
  height: number;
  /** The camera's rate. */
  fps: number;
  /** Tracked frames per second, measured here. */
  trackedFps: number;
  /** Sensor → landmarks, ms (0 when the driver gives no capture time). */
  latencyMs: number;
  hands: number;
}

export const useLiveInputStore = create<LiveInputStatus>(() => ({
  state: 'stopped',
  message: '',
  camera: '',
  width: 0,
  height: 0,
  fps: 0,
  trackedFps: 0,
  latencyMs: 0,
  hands: 0,
}));
