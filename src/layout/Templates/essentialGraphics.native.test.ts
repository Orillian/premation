/**
 * Essential Graphics ▸ Build and Edit through the engine: a property of the
 * selected layer becomes a control as ONE entry stored on the composition, its
 * current value the default; each new kind (font, show / hide, a vector member
 * with its partner, any colour) writes and reads back through the API.
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import { engineIdle } from '@core/engine/engineInstance';
import { edit } from '@core/engine/uiEdits';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';
import type { TemplateField } from '@core/template/templateTypes';
import {
  exposableProperties, exposePropertyAsFieldEdit, mergedFields, mirrorAuthoredFields, moveAuthoredFieldEdit, patchAuthoredFieldEdit, withFieldMoved,
} from './templateAuthoringEdits';
import { templateFieldEditCommands, templateFieldValues } from './templateFieldEdits';
import { useTemplateStore } from '@stores/templateStore';
import type { TemplatePayload } from '@core/library/premium/packFormat';
import type { FragmentLayer } from '@/engine-client/fragmentBuilder';

let h: Harness;
let s: Scene;
let comp: string;

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  documentMirror().start();
  await documentMirror().whenIdle();
  comp = activeCompIdNow()!;
  await documentMirror().loadTrees(documentMirror().layerIds());
});
afterEach(async () => { await h.dispose(); });

async function pick(layer: string, key: string) {
  const all = await exposableProperties(layer);
  const p = all.find((x) => x.key === key);
  if (!p) throw new Error(`no ${key} in ${all.map((x) => x.key).join(', ')}`);
  return p;
}

async function expose(layer: string, key: string): Promise<TemplateField> {
  const n = (await historyLabels()).length;
  const field = await exposePropertyAsFieldEdit(layer, await pick(layer, key), 0);
  await engineIdle();
  await documentMirror().whenIdle();
  expect((await historyLabels()).slice(n)).toEqual(['Expose Template Field']);
  expect(field).not.toBeNull();
  return field!;
}

async function write(field: TemplateField, value: string | number): Promise<void> {
  const cmds = templateFieldEditCommands(field, value, 0);
  expect(cmds).not.toBeNull();
  expect((await edit(`Edit ${field.label}`, cmds!)).ok).toBe(true);
  await engineIdle();
  await documentMirror().whenIdle();
}

test('a text layer lists its text, font, size, colour, transform and visibility', async () => {
  expect(comp).toBe(s.comp);
  const keys = (await exposableProperties(s.T)).map((p) => p.key);
  expect(keys).toEqual(expect.arrayContaining(['text', 'font', 'fontSize', 'layer/fill', 'x', 'y', 'scaleX', 'rotation', 'opacity', 'visible']));
  expect((await pick(s.T, 'scaleX')).alsoTargets?.[0]?.prop).toBe('scaleY');
});

test('font: exposed with the current family, written to the layer, undone exactly', async () => {
  const field = await expose(s.T, 'font');
  expect(field.kind).toBe('font');
  expect(typeof field.default).toBe('string');
  expect(mirrorAuthoredFields(comp).map((f) => f.id)).toContain(field.id);
  const before = await h.doc();
  await write(field, 'Georgia');
  expect((await templateFieldValues([field], 0))[field.id]).toBe('Georgia');
  await h.run({ type: 'undo' });
  expect(await h.doc()).toBe(before);
});

test('show / hide writes the Video switch', async () => {
  const field = await expose(s.T, 'visible');
  expect(field.default).toBe(1);
  await write(field, 0);
  expect(documentMirror().layer(s.T)?.switches.visible).toBe(false);
  expect((await templateFieldValues([field], 0))[field.id]).toBe(0);
});

test('scale writes X and Y together; position X keeps Y', async () => {
  const scale = await expose(s.T, 'scaleX');
  expect(scale.displayScale).toBe(100);
  await write(scale, 1.5);
  const v = await h.query({ type: 'getPropertyValues', props: [{ layer: s.T, path: 'transform/scale' }], time: 0, evaluated: false });
  const sc = v.values[0]!.value as { kind: string; value: { x: number; y: number } };
  expect(sc.value.x).toBeCloseTo(150);
  expect(sc.value.y).toBeCloseTo(150);

  const x = await expose(s.T, 'x');
  const yBefore = (await templateFieldValues([{ ...x, id: 'y', target: { ...x.target, prop: 'y' } }], 0)).y;
  await write(x, 321);
  const after = await templateFieldValues([x, { ...x, id: 'y', target: { ...x.target, prop: 'y' } }], 0);
  expect(after[x.id]).toBeCloseTo(321);
  expect(after.y).toBeCloseTo(Number(yBefore));
});

test('the fill colour of a text layer is a colour control', async () => {
  const field = await expose(s.T, 'layer/fill');
  expect(field.kind).toBe('color');
  await write(field, '#ff0000');
  expect(String((await templateFieldValues([field], 0))[field.id]).toLowerCase()).toMatch(/^#ff0000/);
});

test('re-exposing keeps the control; reorder and regroup are one entry each', async () => {
  const a = await expose(s.T, 'font');
  const b = await expose(s.T, 'visible');
  // Re-exposing the same target changes nothing (no entry, no duplicate).
  expect((await exposePropertyAsFieldEdit(s.T, await pick(s.T, 'font'), 0))?.id).toBe(a.id);
  await documentMirror().whenIdle();
  expect(mirrorAuthoredFields(comp).filter((f) => f.id === a.id)).toHaveLength(1);
  const n = (await historyLabels()).length;
  expect(await moveAuthoredFieldEdit(b.id, -1)).toBe(true);
  expect(await patchAuthoredFieldEdit(a.id, { group: 'Look' }, 'Group Template Field')).toBe(true);
  await engineIdle();
  await documentMirror().whenIdle();
  expect((await historyLabels()).slice(n)).toEqual(['Reorder Template Field', 'Group Template Field']);
  const ids = mirrorAuthoredFields(comp).map((f) => f.id);
  expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
  expect(mirrorAuthoredFields(comp).find((f) => f.id === a.id)?.group).toBe('Look');
});

test('mergedFields renames colliding ids; withFieldMoved clamps', () => {
  const f = (id: string): TemplateField => ({ id, label: id, kind: 'text', default: '', target: { nodeId: 'n', componentType: 'Text', prop: 'content' } });
  expect(mergedFields([f('title')], [f('title'), f('sub')]).map((x) => x.id)).toEqual(['title', 'title2', 'sub']);
  expect(withFieldMoved([f('a'), f('b')], 'a', -5).map((x) => x.id)).toEqual(['a', 'b']);
  expect(withFieldMoved([f('a'), f('b')], 'a', 1).map((x) => x.id)).toEqual(['b', 'a']);
});

function fragLayer(id: string, parent: string | null): FragmentLayer {
  return {
    row: {
      id, name: id, parent, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [{ id: `${id}_t`, type: 'Transform', props: { x: 960, y: 540, scaleX: 1, scaleY: 1 } }],
    },
    anim: null,
    bars: [{ start: 0, duration: 120, sourceIn: 0, sourceDuration: null }],
  };
}

const ELEMENT: TemplatePayload = {
  v: 1,
  mode: 'element',
  settings: { width: 1920, height: 1080, fps: 30, durationSeconds: 4, background: '#000000' },
  layers: [fragLayer('root', null), fragLayer('bar', 'root')],
  fields: [{ id: 'show', label: 'Show bar', kind: 'toggle', group: 'Layout', target: { nodeId: 'bar', componentType: 'Layer', prop: 'visible' }, default: 1 }],
  assets: [],
};

test('an inserted template keeps its controls on the composition; a second insert sits beside the first', async () => {
  expect(await useTemplateStore.getState().applyPayload({ id: 'pro.template.bar', name: 'Bar' }, ELEMENT)).toBe(true);
  await documentMirror().whenIdle();
  let saved = mirrorAuthoredFields(comp);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ id: 'show', kind: 'toggle', group: 'Bar · Layout' });
  expect(documentMirror().layer(saved[0]!.target.nodeId)).toBeDefined();
  expect(await useTemplateStore.getState().applyPayload({ id: 'pro.template.bar', name: 'Bar' }, ELEMENT)).toBe(true);
  await documentMirror().whenIdle();
  saved = mirrorAuthoredFields(comp);
  expect(saved.map((f) => f.id)).toEqual(['show', 'show2']);
  expect(saved[0]!.target.nodeId).not.toBe(saved[1]!.target.nodeId);
  useTemplateStore.getState().exit();
});
