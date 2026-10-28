/**
 * A mask's opacity through the mirror: the Mask Opacity property is in % (as
 * the engine's property tree presents it), `MaskPath.opacity` is 0..1. Reading
 * the percent straight through made every new mask show "10000 %".
 */

import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { buildScene } from '@core/engine/__testHelpers__/scene';
import { documentMirror } from '@stores/documentMirror';
import { mirrorMasksAt } from './masks';

let h: Harness;
beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => { await h.dispose(); });

it('reads a new mask at full opacity and a 50 % one at half', async () => {
  const s = await buildScene(h);
  const { groups: [g] } = await h.run({
    type: 'addMask', layer: s.V, mode: 'add', inverted: false,
    path: { vertices: [0, 0, 50, 0, 50, 50], inTangents: [], outTangents: [], closed: true, featherPoints: [], vertexStates: [] },
  });
  await engineIdle();
  await documentMirror().loadTrees([s.V]);
  expect(mirrorMasksAt(documentMirror(), s.V, 0).map((m) => m.opacity)).toEqual([1]);
  await h.run({ type: 'setProperty', prop: { layer: s.V, path: `${g!}/opacity` }, value: { kind: 'scalar', value: 50 } });
  await engineIdle();
  expect(mirrorMasksAt(documentMirror(), s.V, 0).map((m) => m.opacity)).toEqual([0.5]);
});
