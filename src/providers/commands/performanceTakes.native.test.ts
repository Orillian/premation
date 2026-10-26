/**
 * Takes kept in the project (plan §4.1, D5) over the engine: a Motion Sketch
 * take and a scrub take are stored beside their keys in the SAME entry, the
 * stored take survives save / reopen and undo / redo, and the Detail control
 * re-fits it from the document once the recorder's own buffer is gone.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flicksToSeconds, secondsToFlicks, type Command as EngineCommand, type PerformanceTake } from '@motion/engine-api';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { numbersOfValue } from '@core/mirror/trackIndex';
import { documentMirror } from '@stores/documentMirror';
import { armMotionSketchEdit, canRefitLastTake, finishMotionSketchEdit } from './motionSketchEdits';
import { recordMotionSketchSample } from '@core/animation/motionSketch';
import { beginScrub, finishScrub, moveScrubBy } from './performanceScrub';
import { hasStoredTake, loadPerformanceTake, refitStoredTake } from './performanceTakes';

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

const positions = (): number[][] => documentMirror().keyframes(ID, 'transform/position')
  .map((k) => [flicksToSeconds(k.time), ...numbersOfValue(k.value).slice(0, 2)]);

/** A half circle (radius 200) recorded at 60 Hz over [0, 2] s. */
function recordArc(): void {
  for (let i = 0; i <= 120; i++) {
    const t = i / 60;
    recordMotionSketchSample(ID, 960 + 200 * Math.cos((Math.PI * t) / 2), 540 + 200 * Math.sin((Math.PI * t) / 2), t);
  }
}

const SMART = { tolerance: 0, captureSpeedPct: 100, reduction: 'smart' as const, detail: 0, frameDuration: 1 / 30, source: 'mouse' };

async function storedTake(): Promise<PerformanceTake | null> {
  return loadPerformanceTake(ID, 'position');
}

it('stores the take beside its keys in ONE entry; undo removes both, redo restores both', async () => {
  const before = (await historyLabels()).length;
  armMotionSketchEdit(ID, SMART);
  recordArc();
  const n = await finishMotionSketchEdit();
  await settle();
  expect(n).toBeGreaterThan(0);
  expect((await historyLabels()).length).toBe(before + 1);
  const take = await storedTake();
  expect(take).not.toBeNull();
  expect(take!.path).toBe('transform/position');
  expect(take!.source).toBe('mouse');
  expect(take!.dims).toBe(2);
  expect(take!.times.length).toBe(121);
  expect(take!.values.length).toBe(242);
  expect(take!.fit).toMatchObject({ reduction: 'smart', detail: 0, spatial: true });
  expect(flicksToSeconds(take!.span.start)).toBeCloseTo(0, 6);
  expect(flicksToSeconds(take!.span.start + take!.span.duration)).toBeCloseTo(2, 6);
  expect(await hasStoredTake(ID, 'position')).toBe(true);

  await h.run({ type: 'undo' } as EngineCommand);
  await settle();
  expect(positions()).toEqual([[0.2, 1, 1], [5, 1, 1]]);
  expect(await storedTake()).toBeNull();

  await h.run({ type: 'redo' } as EngineCommand);
  await settle();
  expect(positions().length).toBe(n + 1);
  expect((await storedTake())?.times.length).toBe(121);
});

it('re-fits the stored take from the document after undo / redo (the recorder\'s buffer is stale) as one entry, keeping keys outside the span', async () => {
  armMotionSketchEdit(ID, SMART);
  recordArc();
  const coarse = await finishMotionSketchEdit();
  await settle();
  await h.run({ type: 'undo' } as EngineCommand);
  await h.run({ type: 'redo' } as EngineCommand);
  await settle();
  expect(canRefitLastTake()).toBe(false);
  const before = (await historyLabels()).length;
  const fine = await refitStoredTake(ID, 'position', 100);
  await settle();
  expect(fine).toBeGreaterThan(coarse);
  const labels = await historyLabels();
  expect(labels.length).toBe(before + 1);
  expect(labels.at(-1)).toBe('Adjust Take Detail');
  expect(positions().length).toBe(fine + 1);
  expect(positions().at(-1)).toEqual([5, 1, 1]);
  expect((await storedTake())?.fit.detail).toBe(100);
  // Back to few keys: the stored take is the same samples, so the fit is the same as the first one.
  expect(await refitStoredTake(ID, 'position', 0)).toBe(coarse);
});

it('survives save and reopen: Detail still re-fits the take for the layer', async () => {
  armMotionSketchEdit(ID, SMART);
  recordArc();
  const coarse = await finishMotionSketchEdit();
  await settle();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'premation-takes-'));
  const file = path.join(dir, 'takes.motion');
  try {
    await h.run({ type: 'saveProject', path: file, copy: false } as EngineCommand);
    await h.run({ type: 'newProject' } as EngineCommand);
    await settle();
    expect(await hasStoredTake(ID, 'position')).toBe(false);
    await h.run({ type: 'openProject', path: file } as EngineCommand);
    await settle();
    await documentMirror().loadTree(ID);
    await settle();
    expect(positions().length).toBe(coarse + 1);
    const take = await storedTake();
    expect(take?.times.length).toBe(121);
    expect(take?.fit.detail).toBe(0);
    const fine = await refitStoredTake(ID, 'position', 100);
    await settle();
    expect(fine).toBeGreaterThan(coarse);
    expect(positions().length).toBe(fine + 1);
    expect(positions().at(-1)).toEqual([5, 1, 1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('a scrub take is stored under its property and re-fits from the document', async () => {
  expect(await beginScrub(ID, 'opacity', 0)).toBe(true);
  for (let i = 1; i <= 60; i++) moveScrubBy(-50 * Math.sin((Math.PI * i) / 60), i / 60);
  const n = await finishScrub({ detail: 0, wholeFrames: true, holdSeconds: 0.25, frameDuration: 1 / 30, captureSpeedPct: 100, smart: true, source: 'hand' });
  await settle();
  expect(n).toBeGreaterThan(0);
  const take = await loadPerformanceTake(ID, 'opacity');
  expect(take).not.toBeNull();
  expect(take!.path).toBe('transform/opacity');
  expect(take!.source).toBe('hand');
  expect(take!.dims).toBe(1);
  expect(take!.times.length).toBe(61);
  await h.run({ type: 'undo' } as EngineCommand);
  await h.run({ type: 'redo' } as EngineCommand);
  await settle();
  const fine = await refitStoredTake(ID, 'opacity', 100);
  await settle();
  expect(fine).toBeGreaterThanOrEqual(n);
  expect(documentMirror().keyframes(ID, 'transform/opacity').length).toBe(fine);
  expect((await historyLabels()).at(-1)).toBe('Adjust Take Detail');
});
