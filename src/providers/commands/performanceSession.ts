/**
 * The Performance bar's session (docs/PERFORMANCE_ANIMATION_PLAN.md §2, §8,
 * §10): arm a layer, record takes, set pose keys, adjust a take's Detail.
 *
 * Two modes, one bar:
 *
 *   Perform  the playhead runs and the layer follows the drag (Motion Sketch).
 *            Recording starts at the PRESS on the viewport, not at arming —
 *            After Effects' capture starts at mouse-down too — so there is no
 *            race to grab the layer while the comp is already playing away.
 *            Release (or the window losing focus) finishes the take; Esc
 *            reverts it.
 *   Pose     the playhead is parked; Set Key (button or Enter) keys the target
 *            property's current value at the playhead and steps the playhead
 *            forward. Moving the layer between keys is the ordinary drag.
 *
 * The bar stays up between takes: after a take it shows the key count and the
 * Detail control (smart reduction), Record again re-arms the same layer.
 *
 * Every write goes through the engine API (motionSketchEdits / `edit`); this
 * module holds only editor state (performanceStore) and listeners.
 */

import { flicksToSeconds } from '@motion/engine-api';
import { cancelMotionSketch, tickMotionSketch } from '@core/animation/motionSketch';
import type { GestureEvent } from '@core/live/gestures';
import { useLiveInputStore } from '@stores/liveInputStore';
import { usePlaybackClockStore } from '@stores/playbackClockStore';
import { useProjectStore } from '@stores/projectStore';
import {
  beginScrub,
  cancelScrub,
  canRefitLastScrub,
  finishScrub,
  moveScrub,
  refitLastScrub,
  scrubActive,
  tickScrub,
  type ScrubFitOptions,
} from './performanceScrub';
import { compTime } from '@core/engine/propRefs';
import { edit } from '@core/engine/uiEdits';
import { memberHasExpression } from '@core/mirror/memberExpressions';
import { isTransportPlaying, pauseTransport, playheadSeconds, playTransport, seekPlayhead } from '@core/timeline/timelineView';
import { compFps, activeCompIdNow } from '@hooks/useMirror';
import { t } from '@core/i18n';
import { documentMirror } from '@stores/documentMirror';
import { usePerformanceStore, type PerformanceTarget } from '@stores/performanceStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useUIStore } from '@stores/uiStore';
import { trackRef } from '@layout/Inspector/inspectorEdits';
import {
  armMotionSketchEdit,
  canRefitLastTake,
  disarmMotionSketchEdit,
  finishMotionSketchEdit,
  refitLastTake,
} from './motionSketchEdits';
import { hasStoredTake, refitStoredTake } from './performanceTakes';
import {
  bindHandPosition,
  bindHandScrub,
  grabDriven,
  refreshHandSettings,
  startHandSource,
  stopHandSource,
  unbindHand,
} from './performanceHandSource';

function notify(message: string, level: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
  useUIStore.getState().notify({ level, message, durationMs: 2600 });
}

const set = (patch: Partial<ReturnType<typeof usePerformanceStore.getState>>): void => usePerformanceStore.setState(patch);

/** The legacy track names a target keys (Position: both axes). */
const TARGET_TRACKS: Record<PerformanceTarget, readonly string[]> = {
  position: ['x', 'y'],
  rotation: ['rotation'],
  scale: ['scaleX'],
  opacity: ['opacity'],
};

export function targetLabel(target: PerformanceTarget): string {
  switch (target) {
    case 'position': return t('performance.target.position', 'Position');
    case 'rotation': return t('performance.target.rotation', 'Rotation');
    case 'scale': return t('performance.target.scale', 'Scale');
    case 'opacity': return t('performance.target.opacity', 'Opacity');
  }
}

/**
 * Why `nodeId`'s `target` cannot be recorded, or null when it can
 * (plan §8.1): a locked layer, a property the API cannot address, a property
 * an expression drives (keys under it would record and never show).
 */
export function recordProblem(nodeId: string | null | undefined, target: PerformanceTarget = 'position'): string | null {
  if (!nodeId) return t('performance.problem.noLayer', 'Select one layer to record');
  const m = documentMirror();
  const layer = m.layer(nodeId);
  if (!layer) return t('performance.problem.noLayer', 'Select one layer to record');
  if (layer.switches.locked) return t('performance.problem.locked', 'The layer is locked');
  for (const track of TARGET_TRACKS[target]) {
    const r = trackRef(nodeId, track);
    if (!r || !r.animatable) return t('performance.problem.notAnimatable', '{prop} cannot be animated on this layer', { prop: targetLabel(target) });
    const info = m.tree(nodeId)?.nodes.get(r.ref.path);
    if (info && memberHasExpression(info, r.member)) {
      return t('performance.problem.expression', '{prop} is driven by an expression — turn it off to record', { prop: targetLabel(target) });
    }
  }
  return null;
}

// ── Listeners (installed while the bar is up) ─────────────────────────────────

let listening = false;

function inBar(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-performance-bar]') !== null;
}

function inViewport(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-viewport-stage]') !== null;
}

function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/** Where a scrub take's press landed (screen x), or null when no scrub is in progress. */
let scrubFromX: number | null = null;

const onPointerDown = (e: PointerEvent): void => {
  const s = usePerformanceStore.getState();
  const p = usePreferenceStore.getState();
  // With the hand as the source a press on the viewport is an ordinary press.
  if (s.phase !== 'armed' || p.performanceMode !== 'perform' || p.performanceSource !== 'mouse') return;
  if (e.button !== 0 || inBar(e.target) || !inViewport(e.target)) return;
  if (s.target !== 'position') {
    // A scrub take owns the drag: the viewport must not also select or move.
    e.preventDefault();
    e.stopPropagation();
    scrubFromX = e.clientX;
  }
  startTake();
};

const onPointerMove = (e: PointerEvent): void => {
  if (scrubFromX === null || usePerformanceStore.getState().phase !== 'recording') return;
  e.stopPropagation();
  moveScrub(e.clientX - scrubFromX, playheadSeconds(), e.shiftKey);
};

const onPointerUp = (e: Event): void => {
  if (usePerformanceStore.getState().phase !== 'recording') return;
  if (scrubFromX !== null) e.stopPropagation();
  void endTake();
};

/** While a take records: every playback tick samples the held value (pauses stay pauses). */
let unsubscribeClock: (() => void) | null = null;

function sampleTicks(on: boolean): void {
  unsubscribeClock?.();
  unsubscribeClock = null;
  if (!on) return;
  unsubscribeClock = usePlaybackClockStore.subscribe((state) => {
    const tab = useProjectStore.getState().activeTabId ?? '';
    const t = state.clocks[tab]?.time;
    if (t === undefined) return;
    if (scrubActive()) tickScrub(t);
    else tickMotionSketch(t);
  });
}

const onBlur = (): void => {
  // Plan §8.2: losing focus finishes the take and keeps what was recorded.
  if (usePerformanceStore.getState().phase === 'recording') void endTake();
};

const onKeyDown = (e: KeyboardEvent): void => {
  const s = usePerformanceStore.getState();
  if (s.phase === 'off') return;
  // An open menu / popover (the bar's own ⋯ included) answers its own Esc.
  if (e.target instanceof Element && e.target.closest('[role="menu"], [role="dialog"], [role="listbox"]')) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    if (s.phase === 'recording') cancelTake();
    else closePerformance();
    return;
  }
  if (e.key === 'Enter' && !typing(e.target) && s.phase !== 'recording' && usePreferenceStore.getState().performanceMode === 'pose') {
    e.preventDefault();
    void setPoseKey();
    return;
  }
  // Hand source, Perform: Enter is the Record button (starts, and stops, a take).
  if (e.key === 'Enter' && !typing(e.target) && handOn() && usePreferenceStore.getState().performanceMode === 'perform') {
    e.preventDefault();
    toggleHandTake();
  }
};

function listen(on: boolean): void {
  if (typeof window === 'undefined' || on === listening) return;
  listening = on;
  const method = on ? 'addEventListener' : 'removeEventListener';
  // Capture phase: the viewport's own pointer handlers (selection, the move
  // tool) run after ours, and Esc must reach us before the viewport's own
  // Esc (cancel drag / deselect).
  window[method]('pointerdown', onPointerDown as EventListener, true);
  window[method]('pointermove', onPointerMove as EventListener, true);
  window[method]('pointerup', onPointerUp as EventListener, true);
  window[method]('pointercancel', onPointerUp as EventListener, true);
  window[method]('blur', onBlur);
  window[method]('keydown', onKeyDown as EventListener, true);
}

// ── Actions ───────────────────────────────────────────────────────────────────

function frameDuration(): number {
  const comp = activeCompIdNow();
  return 1 / compFps(comp ? documentMirror().comp(comp) : undefined);
}

/** Today's preferences as Motion Sketch options (`fromTime`: the pre-roll cut). */
function sketchOptions(fromTime?: number): Parameters<typeof armMotionSketchEdit>[1] {
  const p = usePreferenceStore.getState();
  return {
    // Every frame / Smooth keep today's Motion Sketch exactly: tolerance 0
    // (one key per sample) or the classic path smoothing.
    tolerance: p.performanceReduction === 'smooth' ? 2 : 0,
    captureSpeedPct: p.performanceCaptureSpeed,
    reduction: p.performanceReduction,
    detail: p.performanceDetail,
    wholeFrames: p.performanceWholeFrames,
    holdSeconds: p.performanceHoldSeconds,
    frameDuration: frameDuration(),
    source: p.performanceSource,
    ...(fromTime !== undefined ? { fromTime } : {}),
  };
}

function scrubOptions(): ScrubFitOptions {
  const p = usePreferenceStore.getState();
  return {
    detail: p.performanceDetail,
    wholeFrames: p.performanceWholeFrames,
    holdSeconds: p.performanceHoldSeconds,
    frameDuration: frameDuration(),
    captureSpeedPct: p.performanceCaptureSpeed,
    smart: p.performanceReduction === 'smart',
    source: p.performanceSource,
  };
}

/** Which recorder wrote the last take — the Detail control re-fits that one. */
let lastTakeKind: 'sketch' | 'scrub' | null = null;

/**
 * Arm a Perform take on the bar's layer. Position arms Motion Sketch (it
 * snapshots the keys now, before the drag writes); another target arms on
 * the press itself (performanceScrub reads the value there).
 */
function armTake(): void {
  const { nodeId, target } = usePerformanceStore.getState();
  if (!nodeId) return;
  if (target === 'position') armMotionSketchEdit(nodeId, sketchOptions());
  else disarmSketch();
  set({ phase: 'armed' });
}

function disarmSketch(): void {
  cancelMotionSketch();
  disarmMotionSketchEdit();
}

/**
 * Open the bar on `nodeId` (Animation ▸ Motion Sketch). Refuses — with the
 * reason — a layer that cannot be recorded.
 */
export function openPerformance(nodeId: string | undefined): void {
  const problem = recordProblem(nodeId, 'position');
  if (problem || !nodeId) {
    notify(problem ?? t('performance.problem.noLayer', 'Select one layer to record'), 'warning');
    return;
  }
  if (isTransportPlaying()) pauseTransport();
  set({ phase: 'armed', nodeId, target: 'position', lastKeys: 0, poseKeys: 0, storedTake: false });
  listen(true);
  watchStoredTake(true);
  if (usePreferenceStore.getState().performanceMode === 'perform') armTake();
  if (handOn()) void startHand();
}

/** Close the bar; an armed take that recorded nothing is dropped, a running one reverted. */
export function closePerformance(): void {
  const { phase } = usePerformanceStore.getState();
  if (phase === 'armed' || phase === 'recording') {
    disarmSketch();
    cancelScrub();
    if (isTransportPlaying()) pauseTransport();
  }
  scrubFromX = null;
  sampleTicks(false);
  listen(false);
  watchStoredTake(false);
  stopHand();
  set({ phase: 'off', nodeId: null, storedTake: false });
}

/** The press that starts a Perform take: pre-roll, then play. */
function startTake(): void {
  const p = usePreferenceStore.getState();
  const { nodeId, target } = usePerformanceStore.getState();
  if (!nodeId) return;
  const from = playheadSeconds();
  const hand = handOn();
  set({ phase: 'recording', takeStart: from });
  const refuse = (): void => {
    scrubFromX = null;
    unbindHand();
    notify(t('performance.problem.notAnimatable', '{prop} cannot be animated on this layer', { prop: targetLabel(target) }), 'warning');
    set({ phase: 'armed' });
  };
  if (target === 'position') {
    // Re-armed with the pre-roll cut: samples before `from` are not the take.
    if (p.performancePreRoll > 0) armMotionSketchEdit(nodeId, sketchOptions(from));
    if (!hand) {
      run();
      return;
    }
    // The hand's clutch deltas add to the value at the grab.
    void bindHandPosition(nodeId, from, compWidth()).then((ok) => {
      if (!ok) return refuse();
      if (usePerformanceStore.getState().phase === 'recording') run();
    });
    return;
  }
  // A scrub take reads the value at the press before anything plays.
  void beginScrub(nodeId, target, from).then((ok) => {
    if (!ok) return refuse();
    if (hand) bindHandScrub(target);
    if (usePerformanceStore.getState().phase === 'recording') run();
  });

  function run(): void {
    if (p.performancePreRoll > 0) seekPlayhead(Math.max(0, from - p.performancePreRoll));
    sampleTicks(true);
    if (!isTransportPlaying()) playTransport();
  }
}

/** Release: write the take (one undo entry), then show its result. */
async function endTake(): Promise<void> {
  sampleTicks(false);
  if (isTransportPlaying()) pauseTransport();
  const hand = handOn();
  const scrubbing = scrubFromX !== null || scrubActive();
  scrubFromX = null;
  unbindHand();
  set({ phase: 'armed' });
  const n = scrubbing ? await finishScrub(scrubOptions()) : await finishMotionSketchEdit();
  if (usePerformanceStore.getState().phase === 'off') return;
  if (n > 0) {
    lastTakeKind = scrubbing ? 'scrub' : 'sketch';
    set({ phase: 'done', lastKeys: n });
    void refreshStoredTake();
  } else {
    // A press that recorded nothing (a click, a marquee): stay armed and say how.
    // A hand TAP (a short, still pinch) is not a failed take: no toast for it.
    if (hand) {
      if (!lastReleaseWasTap) notify(t('performance.nothingHand', 'Nothing recorded — move your hand while it plays'), 'info');
    } else {
      notify(scrubbing
        ? t('performance.nothingScrub', 'Nothing recorded — drag left or right while it plays')
        : t('performance.nothing', 'Nothing recorded — drag the layer while it plays'), 'info');
    }
    armTake();
  }
  lastReleaseWasTap = false;
}

/** Esc mid-take: revert everything the take wrote, stay armed. */
function cancelTake(): void {
  sampleTicks(false);
  disarmSketch();
  cancelScrub();
  unbindHand();
  scrubFromX = null;
  if (isTransportPlaying()) pauseTransport();
  notify(t('performance.cancelled', 'Take cancelled'), 'info');
  armTake();
}

/** Record again after a take (the bar's Record again button in `done`). */
export function recordAgain(): void {
  if (usePerformanceStore.getState().phase === 'off') return;
  armTake();
}

/** Switch Perform ↔ Pose (a preference: the bar remembers it). */
export function setPerformanceMode(mode: 'perform' | 'pose'): void {
  usePreferenceStore.getState().set('performanceMode', mode);
  const { phase } = usePerformanceStore.getState();
  if (phase === 'off' || phase === 'recording') return;
  if (mode === 'pose') {
    disarmSketch();
    set({ phase: 'armed' });
  } else {
    armTake();
  }
}

/** The property the bar records (Perform) or keys (Pose). */
export function setPerformanceTarget(target: PerformanceTarget): void {
  const { nodeId, phase } = usePerformanceStore.getState();
  if (phase === 'recording') return;
  const problem = recordProblem(nodeId, target);
  if (problem) {
    notify(problem, 'warning');
    return;
  }
  set({ target });
  void refreshStoredTake();
  if (usePreferenceStore.getState().performanceMode === 'perform') armTake();
}

// ── Hand source (plan P1.3) ───────────────────────────────────────────────────

function handOn(): boolean {
  return usePreferenceStore.getState().performanceSource === 'hand';
}

function compWidth(): number {
  const comp = activeCompIdNow();
  return (comp ? documentMirror().comp(comp)?.settings.width : undefined) ?? 1920;
}

/** The last release was a tap (set between the recogniser's release and tap events and endTake's toast). */
let lastReleaseWasTap = false;
let unwatchHand: (() => void) | null = null;

/**
 * What the recogniser saw. Perform: a pinch grabs the layer (Position,
 * Rotation) and opening the hand — or losing it — finishes the take; the
 * pinch-driven targets (Scale, Opacity) start and stop with Record. Pose: a tap
 * or a fist is Set Key.
 */
function onHandEvent(e: GestureEvent): void {
  const s = usePerformanceStore.getState();
  if (s.phase === 'off') return;
  if (usePreferenceStore.getState().performanceMode === 'pose') {
    if ((e.type === 'tap' || e.type === 'fist') && s.phase !== 'recording') void setPoseKey();
    return;
  }
  switch (e.type) {
    case 'grab':
      lastReleaseWasTap = false;
      if (s.phase === 'armed' && grabDriven(s.target)) startTake();
      return;
    case 'tap':
      lastReleaseWasTap = true;
      return;
    case 'release':
      if (s.phase === 'recording' && grabDriven(s.target)) void endTake();
      return;
    case 'lost':
      // Plan §8.5: a hand gone for 0.3 s is a release; the take keeps what it has.
      if (s.phase === 'recording') void endTake();
      return;
    case 'fist':
      return;
  }
}

/** Start the camera and follow the hand; the camera's failures reach the user once each. */
async function startHand(): Promise<void> {
  unwatchHand?.();
  let lastFailure = '';
  const offStatus = useLiveInputStore.subscribe((live) => {
    if (live.state === 'failed' && live.message && live.message !== lastFailure) {
      lastFailure = live.message;
      notify(live.message, 'error');
      // Mid-take the samples so far are kept (plan §8.2: the source going away finishes the take).
      if (usePerformanceStore.getState().phase === 'recording') void endTake();
    }
    if (live.state === 'running') lastFailure = '';
  });
  const offPrefs = usePreferenceStore.subscribe((p, prev) => {
    if (p.performanceHandGain !== prev.performanceHandGain || p.performanceHand !== prev.performanceHand || p.performanceHandMirror !== prev.performanceHandMirror) {
      refreshHandSettings();
    }
  });
  unwatchHand = () => {
    offStatus();
    offPrefs();
  };
  const refused = await startHandSource({ now: playheadSeconds, onEvent: onHandEvent });
  if (refused) notify(refused, 'warning');
}

function stopHand(): void {
  unwatchHand?.();
  unwatchHand = null;
  stopHandSource();
}

/** Mouse ↔ Hand (a preference). Switching to Hand starts the camera; back to Mouse releases it. */
export function setPerformanceSource(source: 'mouse' | 'hand'): void {
  const prev = usePreferenceStore.getState().performanceSource;
  usePreferenceStore.getState().set('performanceSource', source);
  const { phase } = usePerformanceStore.getState();
  if (phase === 'off' || phase === 'recording' || prev === source) return;
  if (source === 'hand') void startHand();
  else stopHand();
}

/**
 * The bar's Record button (and Enter) with the hand as the source: starts a
 * take — the way to record Scale / Opacity, whose pinch is the value, not the
 * grab — and stops the running one. Needs the camera.
 */
export function toggleHandTake(): void {
  const s = usePerformanceStore.getState();
  if (s.phase === 'off' || !handOn() || usePreferenceStore.getState().performanceMode !== 'perform') return;
  if (s.phase === 'recording') {
    void endTake();
    return;
  }
  if (useLiveInputStore.getState().state !== 'running') {
    notify(t('performance.hand.noCamera', 'The camera is not running — see its status in the bar'), 'warning');
    return;
  }
  if (s.phase === 'done') armTake();
  startTake();
}

/** The pose step, in comp seconds. */
function poseStepSeconds(): number {
  const p = usePreferenceStore.getState();
  return p.performancePoseStepUnit === 'seconds' ? p.performancePoseStep : p.performancePoseStep * frameDuration();
}

/**
 * Pose mode's Set Key: key the target's CURRENT value at the playhead (a key
 * even when nothing changed — an explicit request, plan §8.4), then step the
 * playhead. One undo entry per key.
 */
export async function setPoseKey(): Promise<void> {
  const { nodeId, target, poseKeys } = usePerformanceStore.getState();
  const problem = recordProblem(nodeId, target);
  if (problem || !nodeId) {
    notify(problem ?? t('performance.problem.noLayer', 'Select one layer to record'), 'warning');
    return;
  }
  const paths = [...new Set(TARGET_TRACKS[target].map((tr) => trackRef(nodeId, tr)?.ref.path).filter((p): p is string => !!p))];
  const now = playheadSeconds();
  const res = await edit(t('performance.poseKeyLabel', 'Set Pose Key'), {
    type: 'addKeyframes',
    // No value: the property's evaluated value at that time (what is on screen).
    keys: paths.map((path) => ({ prop: { layer: nodeId, path }, time: compTime(now), spatialIn: [], spatialOut: [] })),
  });
  if (!res.ok) return;
  set({ poseKeys: poseKeys + 1 });
  const comp = activeCompIdNow();
  const settings = comp ? documentMirror().comp(comp)?.settings : undefined;
  const end = settings ? flicksToSeconds(settings.duration) : Infinity;
  const next = now + poseStepSeconds();
  if (next > end - frameDuration() / 2) {
    seekPlayhead(end - frameDuration());
    notify(t('performance.poseEnd', 'Reached the end of the composition'), 'info');
    return;
  }
  seekPlayhead(next);
}

let refitTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The Detail control: remembered as the preference and, once the control
 * rests for a moment, the take re-fitted (one undo entry per adjustment, not
 * per slider tick). The take just recorded is re-fitted from the recorder's
 * own samples while they are still valid; otherwise — after a reopen, an
 * undo / redo, another layer — from the take the document holds for the
 * bar's layer and target (plan §4.1).
 */
export function adjustTakeDetail(detail: number): void {
  usePreferenceStore.getState().set('performanceDetail', detail);
  if (!takeIsAdjustable()) return;
  if (refitTimer !== null) clearTimeout(refitTimer);
  refitTimer = setTimeout(() => {
    refitTimer = null;
    const s = usePerformanceStore.getState();
    if (!takeIsAdjustable() || !s.nodeId) return;
    const refit = s.phase === 'done' && lastTakeInMemory()
      ? (lastTakeKind === 'scrub' ? refitLastScrub(detail) : refitLastTake(detail))
      : refitStoredTake(s.nodeId, s.target, detail);
    void refit.then((n) => {
      const now = usePerformanceStore.getState();
      if (n > 0 && now.phase !== 'off' && now.phase !== 'recording') set({ phase: 'done', lastKeys: n });
    });
  }, 250);
}

/** The recorder still holds the last take, and nothing else has edited the document since. */
function lastTakeInMemory(): boolean {
  return lastTakeKind === 'scrub' ? canRefitLastScrub() : lastTakeKind === 'sketch' ? canRefitLastTake() : false;
}

/** Whether the Detail control re-fits a take: the one just recorded, or the one the document holds for the bar's layer and target. */
export function takeIsAdjustable(): boolean {
  const { phase, storedTake } = usePerformanceStore.getState();
  if (phase === 'off' || phase === 'recording') return false;
  return (phase === 'done' && lastTakeInMemory()) || storedTake;
}

// ── The take the document holds (plan §4.1) ───────────────────────────────────

let unwatchStoredTake: (() => void) | null = null;
let storedTakeQuery = 0;

/** Ask the document whether it holds a take for the bar's layer and target; the answer lands in the store. */
export async function refreshStoredTake(): Promise<void> {
  const { nodeId, target, phase } = usePerformanceStore.getState();
  const seq = ++storedTakeQuery;
  const stored = nodeId && phase !== 'off' ? await hasStoredTake(nodeId, target) : false;
  if (seq !== storedTakeQuery) return;
  const now = usePerformanceStore.getState();
  if (now.phase !== 'off' && now.nodeId === nodeId && now.target === target && now.storedTake !== stored) set({ storedTake: stored });
}

/** While the bar is up, every document revision (an undo, a reopen) re-checks the stored take. */
function watchStoredTake(on: boolean): void {
  unwatchStoredTake?.();
  unwatchStoredTake = null;
  storedTakeQuery++;
  if (!on) return;
  unwatchStoredTake = documentMirror().subscribe(['doc'], () => {
    if (usePerformanceStore.getState().phase === 'recording') return;
    void refreshStoredTake();
  });
  void refreshStoredTake();
}

