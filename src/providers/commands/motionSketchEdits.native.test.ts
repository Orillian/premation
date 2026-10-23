/**
 * Motion Sketch's write over the engine: the take lands on Position as one
 * entry, one key per recorded sample at composition time, replacing the keys
 * inside the recorded span and keeping the ones outside it.
 */

import { flicksToSeconds, secondsToFlicks, type Command as EngineCommand } from '@motion/engine-api';
import { armMotionSketch, motionSketchTransaction, recordMotionSketchSample } from '@core/animation/motionSketch';
import { setupAppEngine, historyLabels, sampleTrack } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { numbersOfValue } from '@core/mirror/trackIndex';
import { documentMirror } from '@stores/documentMirror';
import { armMotionSketchEdit, canRefitLastTake, finishMotionSketchEdit, refitLastTake } from './motionSketchEdits';

let h: Harness;
let ID: string;

const settle = async (): Promise<void> => {
  await engineIdle();
  await documentMirror().whenIdle();
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

beforeEach(async () => {
  h = await setupAppEngine();
  ID = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'S', init: [] } as EngineCommand) as { layer: string }).layer;
  await h.run({
    type: 'addKeyframes',
    keys: [0.2, 5].map((t) => ({ prop: { layer: ID, path: 'transform/position' }, time: secondsToFlicks(t), value: { kind: 'vec2', value: { x: 1, y: 1 } }, spatialIn: [], spatialOut: [] })),
  } as EngineCommand);
  await settle();
  await documentMirror().loadTree(ID);
  await settle();
});
afterEach(async () => {
  await h.dispose();
});

it('writes one key per sample on Position, one entry, replacing only the keys inside the span', async () => {
  armMotionSketch(ID);
  recordMotionSketchSample(ID, 10, 20, 0);
  recordMotionSketchSample(ID, 30, 40, 0.5);
  recordMotionSketchSample(ID, 50, 60, 1);
  const n = await finishMotionSketchEdit();
  await settle();
  expect(n).toBe(3);
  expect((await historyLabels()).at(-1)).toBe('Motion Sketch');
  const keys = documentMirror().keyframes(ID, 'transform/position').map((k) => [flicksToSeconds(k.time), ...numbersOfValue(k.value).slice(0, 2)]);
  expect(keys).toEqual([[0, 10, 20], [0.5, 30, 40], [1, 50, 60], [5, 1, 1]]);
});

it('writes nothing when nothing was recorded', async () => {
  armMotionSketch(ID);
  expect(await finishMotionSketchEdit()).toBe(0);
});

const positions = (): number[][] => documentMirror().keyframes(ID, 'transform/position')
  .map((k) => [flicksToSeconds(k.time), ...numbersOfValue(k.value).slice(0, 2)]);

/** A half circle (radius 200) recorded at 60 Hz over [0, 2] s. */
function recordArc(): void {
  for (let i = 0; i <= 120; i++) {
    const t = i / 60;
    recordMotionSketchSample(ID, 960 + 200 * Math.cos((Math.PI * t) / 2), 540 + 200 * Math.sin((Math.PI * t) / 2), t);
  }
}

const SMART = { tolerance: 0, captureSpeedPct: 100, reduction: 'smart' as const, detail: 50, frameDuration: 1 / 30 };

it('writes a smart take as a few eased keys with path handles, keeping keys outside the span', async () => {
  armMotionSketchEdit(ID, SMART);
  recordArc();
  const n = await finishMotionSketchEdit();
  await settle();
  expect(n).toBeGreaterThanOrEqual(2);
  expect(n).toBeLessThanOrEqual(6);
  expect((await historyLabels()).at(-1)).toBe('Motion Sketch');
  const keys = documentMirror().keyframes(ID, 'transform/position');
  // The key at 5 s (outside the take) survives untouched; the one at 0.2 s (inside) is replaced.
  expect(positions().at(-1)).toEqual([5, 1, 1]);
  expect(keys.some((k) => Math.abs(flicksToSeconds(k.time) - 0.2) < 1e-6)).toBe(false);
  expect(keys.some((k) => k.easing === 'bezier' && k.bezier !== undefined)).toBe(true);
  expect(keys.some((k) => k.spatialOut.length >= 2)).toBe(true);
});

it('plays the smart take back along the recorded path (engine evaluation, every frame)', async () => {
  armMotionSketchEdit(ID, SMART);
  recordArc();
  await finishMotionSketchEdit();
  await settle();
  // Detail 50 on this take (range ≈ 447 px) is a 2.2 px tolerance.
  let worst = 0;
  for (let fr = 0; fr <= 60; fr++) {
    const t = fr / 30;
    const x = await sampleTrack(ID, 'x', t);
    const y = await sampleTrack(ID, 'y', t);
    const ex = 960 + 200 * Math.cos((Math.PI * t) / 2);
    const ey = 540 + 200 * Math.sin((Math.PI * t) / 2);
    worst = Math.max(worst, Math.hypot((x ?? NaN) - ex, (y ?? NaN) - ey));
  }
  expect(worst).toBeLessThan(2.3);
});

it('makes the drag\'s live keys and the take ONE undo entry', async () => {
  armMotionSketchEdit(ID, SMART);
  const before = (await historyLabels()).length;
  // What the recording drag does: live keys at the playhead, through the take's gesture.
  const txn = motionSketchTransaction()!;
  for (const t of [0.4, 0.8, 1.2]) {
    txn.send('Motion Sketch', [{ type: 'setProperty', prop: { layer: ID, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 500 * t, y: 0 } }, time: secondsToFlicks(t) } as EngineCommand]);
  }
  recordArc();
  await finishMotionSketchEdit();
  await settle();
  const labels = await historyLabels();
  expect(labels.length).toBe(before + 1);
  expect(labels.at(-1)).toBe('Motion Sketch');
  // The live keys are gone with the take's rebuild.
  expect(positions().some(([t]) => Math.abs(t! - 0.4) < 1e-6 || Math.abs(t! - 1.2) < 1e-6)).toBe(false);
  await h.run({ type: 'undo' } as EngineCommand);
  await settle();
  expect(positions()).toEqual([[0.2, 1, 1], [5, 1, 1]]);
});

it('reverts the live keys of a take that recorded nothing', async () => {
  armMotionSketchEdit(ID, SMART);
  const txn = motionSketchTransaction()!;
  txn.send('Motion Sketch', [{ type: 'setProperty', prop: { layer: ID, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 300, y: 300 } }, time: secondsToFlicks(1) } as EngineCommand]);
  await settle();
  expect(await finishMotionSketchEdit()).toBe(0);
  await settle();
  expect(positions()).toEqual([[0.2, 1, 1], [5, 1, 1]]);
});

it('re-fits the last take at another Detail as its own entry, and only while nothing else edited', async () => {
  armMotionSketchEdit(ID, { ...SMART, detail: 0 });
  recordArc();
  const coarse = await finishMotionSketchEdit();
  await settle();
  expect(canRefitLastTake()).toBe(true);
  const fine = await refitLastTake(100);
  await settle();
  expect(fine).toBeGreaterThan(coarse);
  expect((await historyLabels()).at(-1)).toBe('Adjust Take Detail');
  expect(positions().at(-1)).toEqual([5, 1, 1]);
  // Any other edit makes the take stale: no re-fit over someone else's change.
  await h.run({ type: 'setProperty', prop: { layer: ID, path: 'transform/opacity' }, value: { kind: 'scalar', value: 50 } } as EngineCommand);
  await settle();
  expect(canRefitLastTake()).toBe(false);
  expect(await refitLastTake(10)).toBe(0);
});
