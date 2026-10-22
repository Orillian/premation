/**
 * Preview render quality — two orthogonal levers, both trading fidelity for
 * playback speed:
 *
 *  - `draft`      skips the expensive motion-blur multi-sample pass.
 *  - `resolution` renders fewer pixels (Full/Half/Third/Quarter), the way
 *                 After Effects' viewer resolution does — the content canvas is
 *                 sized down by this divisor and the browser upscales it. This
 *                 is the lever users reach for when preview drops frames; it was
 *                 the one thing missing, so `draft` (motion blur only) was the
 *                 whole quality story.
 */

import { create } from 'zustand';
import { playbackBlitPolicy } from '@core/perf/playbackBlitPolicy';
import { t } from '@core/i18n';

/** 1 = Full, 2 = Half, 3 = Third, 4 = Quarter. */
export type PreviewResolution = 1 | 2 | 3 | 4;

// Getters: `t()` runs when a menu reads a label, never at module scope.
export const RESOLUTION_LABELS: Record<PreviewResolution, string> = {
  get 1() { return t('stores.renderQuality.full', 'Full'); },
  get 2() { return t('stores.renderQuality.half', 'Half'); },
  get 3() { return t('stores.renderQuality.third', 'Third'); },
  get 4() { return t('stores.renderQuality.quarter', 'Quarter'); },
};

/** The pixel fraction each resolution renders — shown next to the label so it's
 *  clear this is a quality/speed lever, not a size change. */
export const RESOLUTION_PERCENT: Record<PreviewResolution, string> = {
  1: '100%',
  2: '50%',
  3: '33%',
  4: '25%',
};

/**
 * Adaptive Resolution — AE's Fast Previews default.
 *
 * While the user is DRAGGING (a gizmo, the playhead, a value field) the
 * picture is a moving target nobody inspects closely; when they let go it is
 * the thing they look at. So the viewport renders at `adaptiveFloor` during a
 * drag — but ONLY when interactive rendering is actually over budget
 * (`slowInteract`, measured the same way `slowPlayback` is). Degrading
 * unconditionally traded away quality nobody needed to lose: on a comp that
 * renders in 4ms, every drag still blurred the whole stage and thinned the
 * grid to nothing, which read as a rendering bug rather than as help. Now a
 * light comp drags at full quality and a heavy one degrades within a few
 * frames — the AE behaviour this feature was named after.
 *
 * A manual Half/Quarter still wins when it is already coarser than the floor —
 * the user asked for less, and adapting must never give them more than they
 * chose.
 *
 * `interacting` is set by the UI store's drag flag (see `bindAdaptiveResolution`)
 * rather than by every pointer handler individually, because the drag flag is
 * already set by all of them — one subscription, not thirty edits.
 */
export type AdaptiveFloor = 2 | 3 | 4;

interface RenderQualityStore {
  draft: boolean;
  resolution: PreviewResolution;
  /** Off → the viewport never changes resolution on its own. Default on. */
  adaptive: boolean;
  /** The resolution a drag drops to. Default Half. */
  adaptiveFloor: AdaptiveFloor;
  /** True while a drag is in flight. Driven, not user-set. */
  interacting: boolean;
  /**
   * True while INTERACTIVE rendering cannot keep up — same hysteresis as
   * `slowPlayback`, fed by `reportInteractFrame` from the viewport's render
   * loop during drags. Sticky across drags (a heavy comp stays heavy between
   * grabs); restored by a run of cheap interactive frames. Driven, not user-set.
   */
  slowInteract: boolean;
  /**
   * True while PLAYBACK cannot keep up — the viewport's render loop reports
   * each frame's cost, and a run of frames over budget flips this on; a run
   * under budget or stopping playback flips it off. A measurement only: it
   * no longer lowers the resolution (see `effectiveResolutionOf`). Driven,
   * not user-set.
   */
  slowPlayback: boolean;
  setDraft: (v: boolean) => void;
  toggle: () => void;
  setResolution: (r: PreviewResolution) => void;
  setAdaptive: (v: boolean) => void;
  setAdaptiveFloor: (f: AdaptiveFloor) => void;
  setInteracting: (v: boolean) => void;
  setSlowPlayback: (v: boolean) => void;
  /**
   * Playback (re)started or seeked at `nowMs`: the next `PLAYBACK_WARMUP_MS`
   * of frames are cold-cache frames and do not count towards a switch.
   */
  notePlaybackStart: (nowMs?: number) => void;
  /**
   * Report one rendered frame's cost while playing. `ms` is the render time,
   * `budgetMs` the frame period, `nowMs` the wall clock (injectable for tests).
   * Returns nothing; updates `slowPlayback` by the hysteresis documented at
   * `PLAYBACK_WINDOW` so neither a hitch nor a burst pumps the resolution.
   */
  reportPlaybackFrame: (ms: number, budgetMs: number, nowMs?: number) => void;
  /**
   * Report one rendered frame's cost during a DRAG (not playing). Flips
   * `slowInteract` by the same hysteresis `reportPlaybackFrame` uses, so a
   * single hitch neither drops quality nor restores it.
   */
  reportInteractFrame: (ms: number, budgetMs: number) => void;
  /**
   * What the viewport should render at RIGHT NOW — the one value renderers
   * read. `resolution` is what the user chose; this is that, degraded while a
   * drag is in flight.
   */
  effectiveResolution: () => PreviewResolution;
  /** Stable string that changes when quality changes (render key). */
  key: () => string;
}

export function effectiveResolutionOf(s: {
  resolution: PreviewResolution; adaptive: boolean; adaptiveFloor: AdaptiveFloor; interacting: boolean; slowPlayback?: boolean; slowInteract?: boolean;
}): PreviewResolution {
  // A drag degrades only when interactive rendering is measured slow — a drag
  // on a comp that renders inside budget keeps full quality. Playback never
  // degrades (2026-10-16): AE plays a preview at the resolution you chose and
  // its cache makes the next pass real time. A heavy comp that dropped to
  // Half mid-play showed a soft picture, and every switch was a new slot size
  // — a frame cache of the other size missing everything, one mis-framed
  // frame — which the owner saw as "low quality, broken" playback. The
  // engine's RAM / disk tiers now hold the range, and a loop that dropped
  // frames fills it at the wrap (session.cpp P9).
  if (!s.adaptive || !(s.interacting && s.slowInteract)) return s.resolution;
  return Math.max(s.resolution, s.adaptiveFloor) as PreviewResolution;
}

/*
  Playback auto-resolution hysteresis (A1, docs/PROGRAM_3D_PERF_UX.md).

  Every Full↔Half switch is a new slot size for the engine — a frame cache that
  misses everything and, measured on the Samurai comp, a 0.3–1.7 s stall. The
  old rule (three slow frames down, 45 cheap frames up) pumped on a cold first
  pass whose drops come in bursts: Full→Half→Full every few seconds, each
  switch a freeze and a soft picture. So:

   • a frame is SLOW when its render time exceeds the frame period or the
     engine dropped frames before it;
   • a degrade needs a SUSTAINED slow run: `PLAYBACK_SLOW_IN_WINDOW` of the
     last `PLAYBACK_WINDOW` frames (a burst of a few drops is not one);
   • the first `PLAYBACK_WARMUP_MS` after play starts or after a seek are cold
     caches and do not count at all;
   • a restore waits `restoreDelayMs` after the degrade (3 s, doubling each
     time full resolution does not hold for `PLAYBACK_HOLD_MS` after a restore,
     capped) AND needs `FAST_FRAMES_TO_RESTORE` consecutive cheap frames;
   • there is never more than one switch per `PLAYBACK_MIN_SWITCH_GAP_MS`.
*/
export const PLAYBACK_WINDOW = 12;
export const PLAYBACK_SLOW_IN_WINDOW = 8;
export const PLAYBACK_WARMUP_MS = 2000;
export const PLAYBACK_MIN_SWITCH_GAP_MS = 10_000;
export const PLAYBACK_RESTORE_DELAY_MS = 3000;
const PLAYBACK_RESTORE_DELAY_MAX_MS = 48_000;
/** A restore undone within this long of it means full resolution does not hold: the next wait doubles. */
const PLAYBACK_HOLD_MS = 20_000;
const FAST_FRAMES_TO_RESTORE = 45;
/** The last `PLAYBACK_WINDOW` frames' slow flags as a bitmask (bit 0 = newest). */
let slowWindow = 0;
let framesInWindow = 0;
let underBudget = 0;
let playStartAt = Number.NEGATIVE_INFINITY;
let lastSwitchAt = Number.NEGATIVE_INFINITY;
let lastDegradeAt = Number.NEGATIVE_INFINITY;
let lastRestoreAt = Number.NEGATIVE_INFINITY;
let restoreDelayMs = PLAYBACK_RESTORE_DELAY_MS;
const WINDOW_MASK = (1 << PLAYBACK_WINDOW) - 1;
const popCount = (v: number): number => { let n = 0; for (let x = v; x !== 0; x &= x - 1) n++; return n; };
const resetPlaybackWindow = (): void => { slowWindow = 0; framesInWindow = 0; underBudget = 0; };
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
/** Separate counters for the interact path — a slow drag frame must not be
 *  cancelled out by a fast playback frame or vice versa. */
const INTERACT_SLOW_TO_DEGRADE = 2;
const INTERACT_FAST_TO_RESTORE = 30;
let interactOver = 0;
let interactUnder = 0;

export const useRenderQualityStore = create<RenderQualityStore>((set, get) => ({
  draft: false,
  resolution: 1,
  adaptive: true,
  adaptiveFloor: 2,
  interacting: false,
  slowInteract: false,
  slowPlayback: false,
  setDraft: (v) => set({ draft: v }),
  toggle: () => set((s) => ({ draft: !s.draft })),
  setResolution: (r) => set({ resolution: r }),
  setAdaptive: (v) => set({ adaptive: v }),
  setAdaptiveFloor: (f) => set({ adaptiveFloor: f }),
  setInteracting: (v) => set((s) => (s.interacting === v ? s : { interacting: v })),
  setSlowPlayback: (v) => {
    // Stopping (or a manual reset) forgets the whole history: the next play
    // starts cold, with the first restore wait and no switch on record.
    resetPlaybackWindow();
    playStartAt = Number.NEGATIVE_INFINITY;
    lastSwitchAt = Number.NEGATIVE_INFINITY;
    lastDegradeAt = Number.NEGATIVE_INFINITY;
    lastRestoreAt = Number.NEGATIVE_INFINITY;
    restoreDelayMs = PLAYBACK_RESTORE_DELAY_MS;
    set((s) => (s.slowPlayback === v ? s : { slowPlayback: v }));
  },
  notePlaybackStart: (nowMs = now()) => {
    playStartAt = nowMs;
    resetPlaybackWindow();
  },
  reportPlaybackFrame: (ms, budgetMs, nowMs = now()) => {
    // The preview cache's blit gate weighs this same measurement against its
    // blit cost, adaptive resolution on or off (see PlaybackBlitPolicy).
    playbackBlitPolicy.noteLiveRender(ms, budgetMs);
    const s = get();
    if (!s.adaptive) return;
    // Cold caches: a seek or a fresh play drops frames whatever the resolution.
    if (nowMs - playStartAt < PLAYBACK_WARMUP_MS) return;
    // A frame is "slow" when it alone eats more than the whole frame period —
    // at that point playback is already dropping frames, and a lower
    // resolution that holds the rate is the better picture.
    const slow = ms > budgetMs;
    slowWindow = ((slowWindow << 1) | (slow ? 1 : 0)) & WINDOW_MASK;
    framesInWindow = Math.min(PLAYBACK_WINDOW, framesInWindow + 1);
    underBudget = slow ? 0 : underBudget + 1;
    const gapOk = nowMs - lastSwitchAt >= PLAYBACK_MIN_SWITCH_GAP_MS;
    if (!s.slowPlayback) {
      if (!gapOk || framesInWindow < PLAYBACK_WINDOW || popCount(slowWindow) < PLAYBACK_SLOW_IN_WINDOW) return;
      // Degraded again soon after a restore: full resolution does not hold,
      // so the next restore waits twice as long — the cycle settles on
      // whatever the comp can actually sustain instead of pumping.
      if (nowMs - lastRestoreAt < PLAYBACK_HOLD_MS) restoreDelayMs = Math.min(restoreDelayMs * 2, PLAYBACK_RESTORE_DELAY_MAX_MS);
      lastSwitchAt = nowMs;
      lastDegradeAt = nowMs;
      resetPlaybackWindow();
      set({ slowPlayback: true });
    } else {
      // Restoring is conservative: at the degraded size frames are cheap, so
      // "under budget" here says little about full-res cost — hence the wait
      // after the degrade, the back-off and the long cheap run.
      if (!gapOk || nowMs - lastDegradeAt < restoreDelayMs || underBudget < FAST_FRAMES_TO_RESTORE) return;
      lastSwitchAt = nowMs;
      lastRestoreAt = nowMs;
      resetPlaybackWindow();
      set({ slowPlayback: false });
    }
  },
  reportInteractFrame: (ms, budgetMs) => {
    const s = get();
    if (!s.adaptive) return;
    if (ms > budgetMs) { interactOver++; interactUnder = 0; }
    else { interactUnder++; interactOver = 0; }
    if (!s.slowInteract && interactOver >= INTERACT_SLOW_TO_DEGRADE) {
      interactOver = 0;
      set({ slowInteract: true });
    } else if (s.slowInteract && interactUnder >= INTERACT_FAST_TO_RESTORE) {
      // Restore cautiously for the same reason as playback: at the degraded
      // size interactive frames are cheap, so a long run is the only real
      // evidence the comp got lighter. Sticky across drags on purpose — a
      // heavy comp should not pay two janky frames at the start of every grab.
      interactUnder = 0;
      set({ slowInteract: false });
    }
  },
  effectiveResolution: () => effectiveResolutionOf(get()),
  key: () => `${get().draft ? 'd' : 'f'}${effectiveResolutionOf(get())}`,
}));

/**
 * Hook the drag flag up. Called once at boot. Returns the unsubscribe.
 *
 * The release is DEBOUNCED by one frame: a drag that ends and a new one that
 * begins within the same tick (a quick re-grab) should not cause a full-res
 * render in between, which on a heavy comp is the stall users feel as "the
 * gizmo sticks". The degrade is immediate — there is nothing to wait for.
 */
export function bindAdaptiveResolution(
  subscribeDrag: (cb: (dragging: boolean) => void) => () => void,
): () => void {
  let release: ReturnType<typeof setTimeout> | null = null;
  const unsub = subscribeDrag((dragging) => {
    if (dragging) {
      if (release) { clearTimeout(release); release = null; }
      useRenderQualityStore.getState().setInteracting(true);
    } else {
      if (release) clearTimeout(release);
      release = setTimeout(() => {
        release = null;
        useRenderQualityStore.getState().setInteracting(false);
      }, 32);
    }
  });
  return () => {
    if (release) clearTimeout(release);
    unsub();
  };
}
