/**
 * The Performance bar's session over the engine: what it refuses to record
 * (plan §8.1), Pose mode's Set Key, and the bar's open / close lifecycle.
 */

import { flicksToSeconds, type Command as EngineCommand } from '@motion/engine-api';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { usePerformanceStore } from '@stores/performanceStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { closePerformance, openPerformance, recordProblem, setPerformanceMode, setPerformanceTarget, setPoseKey } from './performanceSession';

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
  await settle();
  await documentMirror().loadTree(ID);
  await settle();
});
afterEach(async () => {
  closePerformance();
  usePreferenceStore.getState().set('performanceMode', 'perform');
  await h.dispose();
});

it('says why a layer cannot be recorded', async () => {
  expect(recordProblem(undefined)).toMatch(/Select one layer/);
  expect(recordProblem(ID)).toBeNull();
  await h.run({ type: 'setLayerSwitches', layers: [ID], patch: { locked: true } } as EngineCommand);
  await settle();
  expect(recordProblem(ID)).toMatch(/locked/);
});

it('refuses a property an expression drives', async () => {
  await h.run({ type: 'setExpression', prop: { layer: ID, path: 'transform/rotation' }, source: 'time * 10' } as unknown as EngineCommand);
  await settle();
  await documentMirror().loadTree(ID);
  await settle();
  expect(recordProblem(ID, 'rotation')).toMatch(/expression/);
  expect(recordProblem(ID, 'position')).toBeNull();
});

it('opens armed on the layer and closes without writing anything', async () => {
  const before = (await historyLabels()).length;
  openPerformance(ID);
  expect(usePerformanceStore.getState()).toMatchObject({ phase: 'armed', nodeId: ID, target: 'position' });
  closePerformance();
  await settle();
  expect(usePerformanceStore.getState().phase).toBe('off');
  expect((await historyLabels()).length).toBe(before);
});

it('Pose mode keys the target\'s current value at the playhead, one entry per key', async () => {
  usePreferenceStore.getState().set('performanceMode', 'pose');
  openPerformance(ID);
  setPerformanceMode('pose');
  setPerformanceTarget('opacity');
  await setPoseKey();
  await settle();
  const keys = documentMirror().keyframes(ID, 'transform/opacity');
  expect(keys).toHaveLength(1);
  expect(flicksToSeconds(keys[0]!.time)).toBe(0);
  expect((await historyLabels()).at(-1)).toBe('Set Pose Key');
  expect(usePerformanceStore.getState().poseKeys).toBe(1);
});
