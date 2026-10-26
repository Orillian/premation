/**
 * The hand as the Performance bar's source, over the engine (plan P1.3):
 * synthetic live frames go through `applyLiveInputEvent` exactly as the
 * engine's events do, the recogniser's grab / release drive a Position take
 * (ONE undo entry of fitted keys, Undo restores the static value), a tap sets
 * a Pose key, Record toggles a pinch-driven Scale take clamped at 0, and
 * closing the bar turns the source off.
 *
 * The engine here has no hand model, so its own camera start fails in words
 * (liveInput.native.test.ts covers that); the test waits for that failure and
 * then feeds frames itself.
 */

import { flicksToSeconds, type Command as EngineCommand } from '@motion/engine-api';
import { setupAppEngine, historyLabels, sampleTrack } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { syntheticHand } from '@core/live/gestures';
import { applyLiveInputEvent, resetLiveInputForTests } from '@core/live/liveInput';
import { documentMirror } from '@stores/documentMirror';
import { useLiveInputStore } from '@stores/liveInputStore';
import { usePerformanceStore } from '@stores/performanceStore';
import { setTime } from '@stores/playbackClockStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useProjectStore } from '@stores/projectStore';
import { MAIN_VIEWPORT, overlayLayer, requestOverlayLayers } from '@stores/overlayGeometry';
import { handSourceOn } from './performanceHandSource';
import { closePerformance, openPerformance, setPerformanceTarget, toggleHandTake } from './performanceSession';

let h: Harness;
let ID: string;
let seq = 0;

const settle = async (): Promise<void> => {
  await engineIdle();
  await documentMirror().whenIdle();
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

async function waitForState(state: string): Promise<void> {
  for (let i = 0; i < 200 && useLiveInputStore.getState().state !== state; i++) {
    await engineIdle();
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The playhead at comp seconds `t`, then one tracked frame with `hands`. */
function frame(t: number, hands: ReturnType<typeof syntheticHand>[], latencyMs = 0): void {
  const tab = useProjectStore.getState().activeTabId ?? '';
  setTime(tab, t);
  applyLiveInputEvent({ state: 'running', message: '', camera: 'Cam', width: 640, height: 360, fps: 30, seq: ++seq, latencyMs, hands });
}

const open = (x: number, y = 0.5): ReturnType<typeof syntheticHand> => syntheticHand({ x, y, pinch: 0.6 });
const pinched = (x: number, y = 0.5, roll = 0): ReturnType<typeof syntheticHand> => syntheticHand({ x, y, pinch: 0.1, roll });

const savedUser = process.env.PREMATION_HAND_USER_DIR;
const savedBundled = process.env.PREMATION_HAND_DIR;

beforeEach(async () => {
  delete process.env.PREMATION_HAND_USER_DIR;
  delete process.env.PREMATION_HAND_DIR;
  h = await setupAppEngine();
  resetLiveInputForTests();
  seq = 0;
  ID = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'S', init: [] } as EngineCommand) as { layer: string }).layer;
  await settle();
  await documentMirror().loadTree(ID);
  await settle();
  usePreferenceStore.getState().set('performanceSource', 'hand');
  usePreferenceStore.getState().set('performanceMode', 'perform');
  usePreferenceStore.getState().set('performanceReduction', 'smart');
});
afterEach(async () => {
  closePerformance();
  usePreferenceStore.getState().set('performanceSource', 'mouse');
  usePreferenceStore.getState().set('performanceMode', 'perform');
  await settle();
  await h.dispose();
  if (savedUser !== undefined) process.env.PREMATION_HAND_USER_DIR = savedUser;
  if (savedBundled !== undefined) process.env.PREMATION_HAND_DIR = savedBundled;
});

/** Open the bar with the hand as the source and let the engine's own camera start fail first. */
async function openWithHand(): Promise<void> {
  openPerformance(ID);
  expect(handSourceOn()).toBe(true);
  await waitForState('failed');
}

it('a pinch grabs Position, the hand moves it, opening the hand writes ONE entry; Undo restores the static value', async () => {
  await openWithHand();
  const before = (await historyLabels()).length;
  const x0 = (await sampleTrack(ID, 'x', 0))!;
  // Open hand, then a confirmed pinch: the take starts (and reads the value at the grab).
  frame(0, [open(0.5)]);
  frame(0, [pinched(0.5)]);
  frame(0, [pinched(0.5)]);
  await settle();
  expect(usePerformanceStore.getState().phase).toBe('recording');
  // One second at 30 Hz: the hand travels 0.2 of the frame to the LEFT on camera = right on a mirrored screen.
  for (let i = 1; i <= 30; i++) frame(i / 30, [pinched(0.5 - 0.2 * (i / 30))]);
  // Open the hand: the take is written.
  frame(31 / 30, [open(0.3)]);
  frame(32 / 30, [open(0.3)]);
  await settle();
  for (let i = 0; i < 20 && usePerformanceStore.getState().phase !== 'done'; i++) await settle();
  const s = usePerformanceStore.getState();
  expect(s.phase).toBe('done');
  expect(s.lastKeys).toBeGreaterThanOrEqual(2);
  expect(s.lastKeys).toBeLessThanOrEqual(8);
  const labels = await historyLabels();
  expect(labels.length).toBe(before + 1);
  expect(labels.at(-1)).toBe('Motion Sketch');
  // 0.2 frame widths × gain 1 × the comp's width (1920 px) = 384 px, at the take's end.
  expect(await sampleTrack(ID, 'x', 1)).toBeCloseTo(x0 + 384, -1);
  // The first key is the first sample after the grab (one frame in): before it the value holds there.
  expect(Math.abs((await sampleTrack(ID, 'x', 0))! - x0)).toBeLessThan(20);
  await h.run({ type: 'undo' } as EngineCommand);
  await settle();
  expect(documentMirror().keyframes(ID, 'transform/position')).toHaveLength(0);
  expect(await sampleTrack(ID, 'x', 1)).toBeCloseTo(x0, 6);
});

it('Pose mode by hand: a tap (short, still pinch) sets a key and steps the playhead; a fist does too', async () => {
  usePreferenceStore.getState().set('performanceMode', 'pose');
  await openWithHand();
  setPerformanceTarget('opacity');
  frame(0, [open(0.5)]);
  frame(0, [pinched(0.5)]);
  frame(0, [pinched(0.5)]);
  frame(0, [open(0.5)]);
  frame(0, [open(0.5)]);
  await settle();
  for (let i = 0; i < 10 && usePerformanceStore.getState().poseKeys < 1; i++) await settle();
  expect(usePerformanceStore.getState().poseKeys).toBe(1);
  const keys = documentMirror().keyframes(ID, 'transform/opacity');
  expect(keys).toHaveLength(1);
  expect(flicksToSeconds(keys[0]!.time)).toBe(0);
  expect((await historyLabels()).at(-1)).toBe('Set Pose Key');
  // The playhead stepped 10 frames; a fist at the new time keys again.
  const tab = useProjectStore.getState().activeTabId ?? '';
  const fist = syntheticHand({ x: 0.5, y: 0.5, pinch: 0.08, fist: true });
  applyLiveInputEvent({ state: 'running', message: '', camera: 'Cam', width: 640, height: 360, fps: 30, seq: ++seq, latencyMs: 0, hands: [fist] });
  applyLiveInputEvent({ state: 'running', message: '', camera: 'Cam', width: 640, height: 360, fps: 30, seq: ++seq, latencyMs: 0, hands: [fist] });
  await settle();
  for (let i = 0; i < 10 && usePerformanceStore.getState().poseKeys < 2; i++) await settle();
  expect(usePerformanceStore.getState().poseKeys).toBe(2);
  expect(documentMirror().keyframes(ID, 'transform/opacity')).toHaveLength(2);
  void tab;
});

it('Scale by pinch: Record starts the take, the pinch closing drives Scale down, clamped at 0; Record again writes one entry', async () => {
  await openWithHand();
  setPerformanceTarget('scale');
  const before = (await historyLabels()).length;
  // The camera must be running (a frame says so) before Record is accepted.
  frame(0, [open(0.5)]);
  toggleHandTake();
  await settle();
  expect(usePerformanceStore.getState().phase).toBe('recording');
  // The pinch closes from 0.6 to 0.1 over a second: −0.5 × 200 % = −100 % → 0, clamped.
  for (let i = 1; i <= 30; i++) frame(i / 30, [syntheticHand({ x: 0.5, y: 0.5, pinch: 0.6 - 0.5 * (i / 30) })]);
  for (let i = 31; i <= 45; i++) frame(i / 30, [syntheticHand({ x: 0.5, y: 0.5, pinch: 0.02 })]); // past touching: still 0
  toggleHandTake();
  await settle();
  for (let i = 0; i < 20 && usePerformanceStore.getState().phase !== 'done'; i++) await settle();
  expect(usePerformanceStore.getState().phase).toBe('done');
  expect((await historyLabels()).length).toBe(before + 1);
  expect(await sampleTrack(ID, 'scaleX', 1.5)).toBeCloseTo(0, 1);
  for (let fr = 0; fr <= 45; fr++) expect((await sampleTrack(ID, 'scaleX', fr / 30))!).toBeGreaterThanOrEqual(-1e-6);
});

/** The same pinch travel as the first test: 0.2 of the frame to the left on camera over a second, then the hand opens. */
async function pinchTravel(): Promise<void> {
  frame(0, [open(0.5)]);
  frame(0, [pinched(0.5)]);
  frame(0, [pinched(0.5)]);
  await settle();
  expect(usePerformanceStore.getState().phase).toBe('recording');
  for (let i = 1; i <= 30; i++) frame(i / 30, [pinched(0.5 - 0.2 * (i / 30))]);
  frame(31 / 30, [open(0.3)]);
  frame(32 / 30, [open(0.3)]);
  await settle();
  for (let i = 0; i < 20 && usePerformanceStore.getState().phase !== 'done'; i++) await settle();
  expect(usePerformanceStore.getState().phase).toBe('done');
}

it('under a parent turned 90°, the hand\'s travel is converted through the parent\'s inverse: the same comp-space distance as unparented', async () => {
  // A parent null turned 90°, the layer under it (world transform kept).
  const P = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'null', name: 'P', init: [] } as EngineCommand) as { layer: string }).layer;
  await h.run({ type: 'setProperty', prop: { layer: P, path: 'transform/rotation' }, value: { kind: 'scalar', value: 90 }, time: 0 } as EngineCommand);
  await h.run({ type: 'setParent', layers: [ID], parent: P, keepWorldTransform: true } as EngineCommand);
  await settle();
  await documentMirror().loadTree(P);
  await documentMirror().loadTree(ID);
  // The parent's world matrix comes with the viewport's frame geometry (what the
  // pointer path reads too): subscribe as the workspace canvas does and wait for a frame.
  await requestOverlayLayers(MAIN_VIEWPORT, 'hand-test', [P, ID], ['transform']);
  for (let i = 0; i < 100 && (overlayLayer(MAIN_VIEWPORT, P, 0)?.matrix?.length ?? 0) !== 16; i++) await settle();
  expect(overlayLayer(MAIN_VIEWPORT, P, 0)?.matrix?.length).toBe(16);
  await openWithHand();
  const x0 = (await sampleTrack(ID, 'x', 0))!;
  const y0 = (await sampleTrack(ID, 'y', 0))!;
  await pinchTravel();
  const dx = (await sampleTrack(ID, 'x', 1))! - x0;
  const dy = (await sampleTrack(ID, 'y', 1))! - y0;
  // 384 comp px to the right in WORLD space is, in a parent turned 90°, a move along the parent's y.
  expect(Math.abs(dx)).toBeLessThan(6);
  expect(Math.abs(dy)).toBeCloseTo(384, -1);
  expect(Math.hypot(dx, dy)).toBeCloseTo(384, -1);
  await requestOverlayLayers(MAIN_VIEWPORT, 'hand-test', [], []);
});

it('losing the hand for 0.3 s finishes a running take and keeps it; closing the bar turns the source off', async () => {
  await openWithHand();
  frame(0, [open(0.5)]);
  frame(0, [pinched(0.5)]);
  frame(0, [pinched(0.5)]);
  await settle();
  for (let i = 1; i <= 15; i++) frame(i / 30, [pinched(0.5, 0.5 - 0.2 * (i / 15))]);
  // No hand at all, for longer than the recogniser's lostMs (real time: its clock).
  await new Promise((r) => setTimeout(r, 350));
  frame(16 / 30, []);
  await settle();
  for (let i = 0; i < 20 && usePerformanceStore.getState().phase !== 'done'; i++) await settle();
  expect(usePerformanceStore.getState().phase).toBe('done');
  expect((await historyLabels()).at(-1)).toBe('Motion Sketch');
  closePerformance();
  expect(handSourceOn()).toBe(false);
  expect(usePerformanceStore.getState().phase).toBe('off');
});
