/**
 * An expression on an effect parameter sees that parameter's own value as
 * `value` (2026-10-21 QA: Alt-click on Gaussian Blur ▸ Blurriness attached
 * `value` and the blur dropped from its default 10 px to 0 — `value` read the
 * layer's components, where an effect parameter is not stored).
 */

import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';

let h: Harness;
beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => { await h.dispose(); });

async function blurriness(layer: string, path: string): Promise<number> {
  const r = await h.query({ type: 'getPropertyValues', props: [{ layer, path }], time: 0, evaluated: true });
  const v = r.values[0]!.value;
  return v.kind === 'scalar' ? v.value : NaN;
}

test('`value` on an untouched parameter is its default, and `value * 2` doubles it', async () => {
  const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'Box', init: [] });
  const { groups: [fx] } = await h.run({ type: 'addEffect', layers: [layer], effect: 'gaussian-blur', params: [] });
  const path = `${fx}/blurriness`;
  const before = await blurriness(layer, path);
  expect(before).toBeGreaterThan(0);

  await h.run({ type: 'setExpression', prop: { layer, path }, source: 'value', enabled: true });
  expect(await blurriness(layer, path)).toBeCloseTo(before);

  await h.run({ type: 'setExpression', prop: { layer, path }, source: 'value * 2', enabled: true });
  expect(await blurriness(layer, path)).toBeCloseTo(before * 2);
});
