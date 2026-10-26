/**
 * The Performance bar's state (docs/PERFORMANCE_ANIMATION_PLAN.md §10) —
 * editor state, never the document. The session that drives it lives in
 * providers/commands/performanceSession.ts; the bar only reads this and calls
 * the session's actions.
 *
 *   off        no bar
 *   armed      the bar is up; Perform waits for a drag, Pose for Set Key
 *   recording  a take is being recorded (Perform)
 *   done       a take was written; its Detail can still be adjusted
 *
 * `storedTake`: the document holds a take for the bar's layer and target
 * (plan §4.1) — Detail re-fits it even after the project was reopened or the
 * take undone and redone. Refreshed by the session, never written by the bar.
 */

import { create } from 'zustand';

export type PerformancePhase = 'off' | 'armed' | 'recording' | 'done';

/** What Pose mode keys and the bar's target chip names. Perform records Position. */
export type PerformanceTarget = 'position' | 'rotation' | 'scale' | 'opacity';

export interface PerformanceState {
  phase: PerformancePhase;
  /** The layer the bar records onto. */
  nodeId: string | null;
  target: PerformanceTarget;
  /** Comp seconds where the current take started (recording), for the bar's clock. */
  takeStart: number;
  /** Keys the last take wrote (done). */
  lastKeys: number;
  /** Pose keys set since the bar opened. */
  poseKeys: number;
  /** The document holds a take for `nodeId`'s `target` that Detail can re-fit. */
  storedTake: boolean;
}

export const usePerformanceStore = create<PerformanceState>(() => ({
  phase: 'off',
  nodeId: null,
  target: 'position',
  takeStart: 0,
  lastKeys: 0,
  poseKeys: 0,
  storedTake: false,
}));
