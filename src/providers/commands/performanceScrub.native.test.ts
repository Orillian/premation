/**
 * Scrub takes over the engine (plan P0.3): a dragged value recorded onto
 * Opacity / Rotation as one entry, clamped to the property's range, a pause
 * kept as a hold, Undo back to the static value, and the Detail re-fit.
 */

import { flicksToSeconds, type Command as EngineCommand } from '@motion/engine-api';
import { setupAppEngine, historyLabels, sampleTrack } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { beginScrub, canRefitLastScrub, finishScrub, moveScrub, refitLastScrub, tickScrub, type ScrubFitOptions } from './performanceScrub';

let h: Harness;
let ID: string;

const settle = async (): Promise<void> => {
  await engineIdle();
  await documentMirror().whenIdle();
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

const OPTS: ScrubFitOptions = { detail: 50, wholeFrames: true, holdSeconds: 0.25, frameDuration: 1 / 30, captureSpeedPct: 100, smart: true };

beforeEach(async () => {
  h = await setupAppEngine();
  ID = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'S', init: [] } as EngineCommand) as { layer: string }).layer;
  await settle();
  await documentMirror().loadTree(ID);
  await settle();
});
afterEach(async () => {
  await h.dispose();
});

it('records a scrubbed Opacity as one entry, clamped to 0–100, and Undo restores the static value', async () => {
  const before = (await historyLabels()).length;
  expect(await beginScrub(ID, 'opacity', 0)).toBe(true);
  // Drag left 600 px over one second: −150 % asked, clamped at 0.
  for (let i = 1; i <= 60; i++) moveScrub(-10 * i, i / 60, false);
  await settle();
  const n = await finishScrub(OPTS);
  await settle();
  expect(n).toBeGreaterThanOrEqual(2);
  expect((await historyLabels()).length).toBe(before + 1);
  expect(await sampleTrack(ID, 'opacity', 1)).toBeCloseTo(0, 1);
  for (let fr = 0; fr <= 30; fr++) {
    const v = (await sampleTrack(ID, 'opacity', fr / 30))!;
    expect(v).toBeGreaterThanOrEqual(-1e-6);
    expect(v).toBeLessThanOrEqual(100 + 1e-6);
  }
  await h.run({ type: 'undo' } as EngineCommand);
  await settle();
  expect(documentMirror().keyframes(ID, 'transform/opacity')).toHaveLength(0);
});

it('keeps a pause as a hold when the pointer rests (clock ticks)', async () => {
  expect(await beginScrub(ID, 'rotation', 0)).toBe(true);
  for (let i = 1; i <= 30; i++) moveScrub(4 * i, i / 60, false); // 0 → 60° over 0.5 s
  for (let i = 31; i <= 90; i++) tickScrub(i / 60); // rest for a second
  for (let i = 91; i <= 120; i++) moveScrub(120 + 4 * (i - 90), i / 60, false); // 60° → 120°
  await finishScrub(OPTS);
  await settle();
  const keys = documentMirror().keyframes(ID, 'transform/rotation');
  expect(keys.some((k) => k.easing === 'hold')).toBe(true);
  expect(await sampleTrack(ID, 'rotation', 1)).toBeCloseTo(60, 0);
  expect(flicksToSeconds(keys.at(-1)!.time)).toBeCloseTo(2, 6);
});

it('writes nothing, and reverts the live writes, for a press that never moved', async () => {
  expect(await beginScrub(ID, 'opacity', 0)).toBe(true);
  for (let i = 1; i <= 20; i++) tickScrub(i / 60);
  expect(await finishScrub(OPTS)).toBe(0);
  await settle();
  expect(documentMirror().keyframes(ID, 'transform/opacity')).toHaveLength(0);
});

it('re-fits the last scrub take at another Detail', async () => {
  expect(await beginScrub(ID, 'rotation', 0)).toBe(true);
  for (let i = 1; i <= 120; i++) moveScrub(200 * Math.sin((Math.PI * i) / 60), i / 60, false);
  const coarse = await finishScrub({ ...OPTS, detail: 0 });
  await settle();
  expect(canRefitLastScrub()).toBe(true);
  const fine = await refitLastScrub(100);
  await settle();
  expect(fine).toBeGreaterThan(coarse);
  expect((await historyLabels()).at(-1)).toBe('Adjust Take Detail');
});
