/**
 * Layer ▸ Arrange ▸ Place Behind Subject through the engine: the footage is
 * duplicated, the copy keeps the subject matte, the original loses it, and
 * the chosen layers land between them — one undo entry.
 */

import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import { childOrderOf } from '@core/mirror/layerTree';
import { mirrorMaskHeaders } from '@core/mirror/effects';
import { ROTO_PATH_NAME } from '@core/workspace/rotoBrushTool';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { planPlaceBehindSubject, placeBehindSubjectEdit } from './placeBehindSubject';

let h: Harness;
let s: Scene;

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  useSelectionStore.getState().clear();
});

afterEach(async () => {
  await h.dispose();
});

const order = (): string[] => childOrderOf(documentMirror(), s.comp);

async function masksOf(id: string): Promise<string[]> {
  await documentMirror().loadTrees([id]);
  return mirrorMaskHeaders(documentMirror().tree(id)).map((m) => m.name);
}

it('plans from text + shape: the footage below them, the layers back → front', () => {
  const r = planPlaceBehindSubject([s.B, s.T]);
  expect(r).toEqual({ ok: true, plan: { footage: s.V, behind: [s.T, s.B], comp: s.comp, parent: s.comp } });
});

it('refuses a selection with nothing to put behind', () => {
  expect(planPlaceBehindSubject([]).ok).toBe(false);
  expect(planPlaceBehindSubject([s.V]).ok).toBe(false);
});

it('sandwiches the layers between the footage and a cut-out copy, moving the matte to the copy, as one entry', async () => {
  await h.run({
    type: 'addMask', layer: s.V, mode: 'add', inverted: false, name: ROTO_PATH_NAME,
    path: { vertices: [0, 0, 50, 0, 50, 50, 0, 50], inTangents: [], outTangents: [], closed: true, featherPoints: [], vertexStates: [] },
  });
  await engineIdle();
  const before = order();
  const entries = (await historyLabels()).length;
  const plan = planPlaceBehindSubject([s.T, s.B]);
  if (!plan.ok) throw new Error(plan.message);
  const r = await placeBehindSubjectEdit(plan.plan);
  await engineIdle();
  expect(r).not.toBeNull();
  expect(r!.hadMatte).toBe(true);
  const after = order();
  const v = after.indexOf(s.V);
  expect(after.slice(v, v + 4)).toEqual([s.V, s.T, s.B, r!.subject]);
  expect(await masksOf(s.V)).not.toContain(ROTO_PATH_NAME);
  expect(await masksOf(r!.subject)).toContain(ROTO_PATH_NAME);
  expect(documentMirror().layer(r!.subject)?.name).toMatch(/\(subject\)$/);
  expect((await historyLabels()).length).toBe(entries + 1);

  await h.run({ type: 'undo' });
  await engineIdle();
  expect(order()).toEqual(before);
  expect(await masksOf(s.V)).toContain(ROTO_PATH_NAME);
});

it('builds the sandwich with no matte yet, and says so', async () => {
  const plan = planPlaceBehindSubject([s.T]);
  if (!plan.ok) throw new Error(plan.message);
  const r = await placeBehindSubjectEdit(plan.plan);
  await engineIdle();
  expect(r?.hadMatte).toBe(false);
  const after = order();
  const v = after.indexOf(s.V);
  expect(after.slice(v, v + 3)).toEqual([s.V, s.T, r!.subject]);
});
