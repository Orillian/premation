/**
 * AE keyframe colour labels: the diamond menu's Label writes `label` on every
 * targeted key in ONE entry, the timeline rows carry it to the glyph, and None
 * clears it.
 */

import { setupAppEngine, historyLabels, settleEdits, sec, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { documentMirror } from '@stores/documentMirror';
import { fetchTimelineRows } from '@stores/timelineRows';
import { selectionKeyId } from '@core/mirror/keySelection';
import { keyframeLabelColor, LABEL_COLORS } from '@core/scene/labelColor';
import { buildPropertyRows } from './buildPropertyRows';
import { setKeyLabelOnKeys } from './keyframeEdits';

let h: Harness;
let A = '';
let keys: string[] = [];

beforeEach(async () => {
  h = await setupAppEngine();
  A = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'a', init: [] })).layer;
  keys = (await h.run({
    type: 'addKeyframes',
    keys: [0, 1, 2].map((t) => ({ prop: { layer: A, path: 'transform/opacity' }, time: sec(t), value: { kind: 'scalar', value: 50 + t }, spatialIn: [], spatialOut: [] })),
  })).ids;
});
afterEach(async () => { await h.dispose(); });

const opacityKeys = async () => {
  await settleEdits();
  await documentMirror().loadTree(A);
  await fetchTimelineRows([A]);
  return buildPropertyRows(A).find((r) => r.prop === 'opacity')?.keyframes ?? [];
};

it('labels the targeted keys in one entry, and the rows carry the label to the glyph', async () => {
  await setKeyLabelOnKeys([selectionKeyId(A, keys[0]!), selectionKeyId(A, keys[2]!)], 3);
  await settleEdits();
  expect((await historyLabels()).at(-1)).toBe('Label keyframes');
  const rowKeys = await opacityKeys();
  expect(rowKeys.map((k) => k.label ?? 0)).toEqual([3, 0, 3]);
  expect(keyframeLabelColor(3)).toBe(LABEL_COLORS[2]!.color);
  // None clears it.
  await setKeyLabelOnKeys([selectionKeyId(A, keys[0]!)], 0);
  expect((await opacityKeys()).map((k) => k.label ?? 0)).toEqual([0, 0, 3]);
  await h.run({ type: 'undo' });
  expect((await opacityKeys()).map((k) => k.label ?? 0)).toEqual([3, 0, 3]);
});

it('has no colour for no label or an index past the palette', () => {
  expect(keyframeLabelColor(0)).toBeUndefined();
  expect(keyframeLabelColor(LABEL_COLORS.length + 1)).toBeUndefined();
});
