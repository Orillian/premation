/**
 * A placed composition is stored with kind "comp" (and fx.precomp = true), so
 * catalog fields meant for comp layers must gate on that, not on a "precomp"
 * kind no layer carries. Pinned on the app engine's property tree.
 */

import { setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import { engineIdle } from '@core/engine/engineInstance';

jest.useFakeTimers();

const COMP_FIELDS = ['layer/compOverrides', 'layer/viewCamera', 'audio/effects', 'audio/ducking', 'audio/gate'];

let h: Harness;
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  await engineIdle();
});
afterEach(async () => {
  await h.dispose();
});

async function treePaths(layer: string): Promise<string[]> {
  const tree = (await h.query({ type: 'getPropertyTree', layer, path: '', depth: 16 } as never)) as unknown as {
    nodes: Array<{ path: string }>;
  };
  return tree.nodes.map((n) => n.path);
}

test('a comp layer offers the comp-only and audio fields', async () => {
  const { layer } = await h.run({ type: 'createLayer', comp: s.comp, kind: 'precomp', name: 'C2', source: s.comp2, init: [] });
  await engineIdle();
  const paths = await treePaths(layer);
  expect(COMP_FIELDS.map((p) => [p, paths.includes(p)])).toEqual(COMP_FIELDS.map((p) => [p, true]));
});

test('a solid offers none of them', async () => {
  const { layer } = await h.run({ type: 'createLayer', comp: s.comp, kind: 'solid', name: 'S', init: [] });
  await engineIdle();
  const paths = await treePaths(layer);
  expect(COMP_FIELDS.map((p) => [p, paths.includes(p)])).toEqual(COMP_FIELDS.map((p) => [p, false]));
});
