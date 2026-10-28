/**
 * Responsive Design – Time on the C++ engine: a composition stretched off its
 * authored length plays its protected regions at authored speed and stretches
 * only the rest (the editor's template/responsiveTime.ts, now the engine's
 * comp_to_keyframe_time). Keys report where they PLAY on the stretched axis.
 */

import { setupAppEngine, sec, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { flicksToSeconds } from '@motion/engine-api';
import { stretchedToAuthored } from './responsiveTime';

let h: Harness;
let A = '';
const COMP = 'comp_root';

beforeEach(async () => {
  h = await setupAppEngine();
  await h.run({ type: 'setCompositionSettings', comp: COMP, patch: { duration: sec(4) } });
  A = (await h.run({ type: 'createLayer', comp: COMP, kind: 'solid', name: 'a', init: [] })).layer;
  // Opacity 0 → 100 over the 1 s intro, held, 100 → 0 over the 1 s outro.
  await h.run({
    type: 'addKeyframes',
    keys: [[0, 0], [1, 100], [3, 100], [4, 0]].map(([t, v]) => ({
      prop: { layer: A, path: 'transform/opacity' }, time: sec(t!), value: { kind: 'scalar', value: v! }, spatialIn: [], spatialOut: [],
    })),
  });
});
afterEach(async () => { await h.dispose(); });

const opacityAt = async (t: number): Promise<number> => {
  const r = await h.query({ type: 'getPropertyValues', props: [{ layer: A, path: 'transform/opacity' }], time: sec(t), evaluated: true });
  const v = r.values[0]!.value;
  return v.kind === 'scalar' ? v.value : NaN;
};

it('keeps protected intro and outro at authored speed when the comp is stretched', async () => {
  await h.run({
    type: 'setCompositionSettings',
    comp: COMP,
    patch: {
      duration: sec(8),
      responsiveTime: JSON.stringify({ authoredDurationSec: 4, protectedRegions: [{ startSec: 0, endSec: 1 }, { startSec: 3, endSec: 4 }] }),
    },
  });
  // Intro: the same half-way value at 0.5 s as before the stretch.
  expect(await opacityAt(0.5)).toBeCloseTo(50, 3);
  // Outro: the last second of the 8 s comp plays the authored last second.
  expect(await opacityAt(7.5)).toBeCloseTo(50, 3);
  // The middle holds longer (it was 2 s, now 6 s).
  expect(await opacityAt(4)).toBeCloseTo(100, 3);
  // The engine and the editor's map agree on the stretched axis.
  expect(stretchedToAuthored(7.5, 4, 8, [{ startSec: 0, endSec: 1 }, { startSec: 3, endSec: 4 }])).toBeCloseTo(3.5, 6);
  // The outro's keys are drawn where they play: 3 s → 7 s, 4 s → 8 s.
  const keys = await h.query({ type: 'getKeyframes', props: [{ layer: A, path: 'transform/opacity' }] });
  expect(keys.sets[0]!.keyframes.map((k) => flicksToSeconds(k.time))).toEqual([0, 1, 7, 8].map((x) => expect.closeTo(x, 3)));
});

it('without protected regions the comp keeps its own timing (no responsive record)', async () => {
  await h.run({ type: 'setCompositionSettings', comp: COMP, patch: { duration: sec(8) } });
  expect(await opacityAt(0.5)).toBeCloseTo(50, 3);
  expect(await opacityAt(4)).toBeCloseTo(0, 3);
});
