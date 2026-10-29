/**
 * AE's data footage: a .json / .csv / .tsv file imports as a DATA item and
 * expressions read it — footage("name").sourceData, dataValue, dataKeyCount,
 * sourceText — on the C++ engine. Saving the file again is picked up on the
 * next evaluation (the engine re-reads it when its size or time changes).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';

let h: Harness;
let dir = '';
let layer = '';

beforeEach(async () => {
  h = await setupAppEngine();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'premation-data-'));
  layer = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'S', init: [] })).layer;
});
afterEach(async () => {
  await h.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function importData(name: string, text: string): Promise<string> {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  const { items } = await h.run({ type: 'importFiles', files: [{ path: file, asSequence: false, createComposition: false }] });
  return items[0]!;
}

async function evalOpacity(source: string): Promise<number> {
  await h.run({ type: 'setExpression', prop: { layer, path: 'transform/opacity' }, source, enabled: true });
  const r = await h.query({ type: 'getPropertyValues', props: [{ layer, path: 'transform/opacity' }], time: 0, evaluated: true });
  const v = r.values[0]!.value;
  return v.kind === 'scalar' ? v.value : NaN;
}

it('reads JSON through sourceData and dataValue', async () => {
  await importData('stats.json', JSON.stringify({ title: 'Q3', values: [12, 34, 56], nested: { 'best month': { score: 78 } } }));
  expect(await evalOpacity('footage("stats.json").sourceData.values[2]')).toBe(56);
  expect(await evalOpacity('footage("stats.json").sourceData.nested["best month"].score')).toBe(78);
  expect(await evalOpacity('footage("stats.json").dataValue(["values", 1])')).toBe(34);
  expect(await evalOpacity('footage("stats.json").dataKeyCount(["values"])')).toBe(3);
  expect(await evalOpacity('footage("STATS.JSON").sourceData.values.length')).toBe(3);  // the name ignores case
  expect(await evalOpacity('footage("stats.json").sourceText.length')).toBeGreaterThan(10);
});

it('reads CSV and TSV by column and data row, header first', async () => {
  await importData('sales.csv', 'month,units,"note, quoted"\r\nJan,10,a\r\nFeb,25,"b, c"\r\nMar,40,d\r\n');
  expect(await evalOpacity('footage("sales.csv").dataValue([1, 1])')).toBe(25);
  expect(await evalOpacity('footage("sales.csv").dataKeyCount([1])')).toBe(3);
  expect(await evalOpacity('footage("sales.csv").sourceData[2].units')).toBe(40);
  expect(await evalOpacity('footage("sales.csv").sourceData[1]["note, quoted"].length')).toBe(4);
  await importData('t.tsv', 'x\ty\n1\t2\n3\t4\n');
  expect(await evalOpacity('footage("t.tsv").dataValue([1, 1])')).toBe(4);
});

it('re-reads the file when it is saved again', async () => {
  const file = path.join(dir, 'live.json');
  await importData('live.json', '{"v": 5}');
  expect(await evalOpacity('footage("live.json").sourceData.v')).toBe(5);
  fs.writeFileSync(file, '{"v": 77, "pad": "makes the size change"}');
  expect(await evalOpacity('footage("live.json").sourceData.v')).toBe(77);
});

it('names what is wrong: a missing item, malformed JSON', async () => {
  await importData('bad.json', '{"a": [1, 2,}');
  const errorOf = async (source: string): Promise<string> => {
    const r = await h.query({ type: 'evaluateExpression', prop: { layer, path: 'transform/opacity' }, time: 0, source });
    return r.diagnostics.map((d) => d.message).join(" | ");
  };
  expect(await errorOf('footage("bad.json").sourceData.a[0]')).toMatch(/invalid JSON .* line 1/);
  expect(await errorOf('footage("nope.json").sourceData')).toMatch(/no data footage named/i);
});
