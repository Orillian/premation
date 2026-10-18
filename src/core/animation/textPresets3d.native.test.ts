/**
 * The Text/3D presets on the app's engine: applying one that moves characters
 * in depth (z / X Rotation / Y Rotation) switches the layer to 3D with
 * per-character 3D, so the characters turn instead of flattening; a flat
 * preset leaves the layer 2D.
 */

import { setupAppEngine, sec, settleEdits, type AppHarness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';
import { docView } from '@core/engine/__testHelpers__/docView';
import { readAnimatorData } from '@core/text/textAnimators';

let h: AppHarness;
beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => { await h.dispose(); });

async function perCharacter3D(layer: string): Promise<unknown> {
  const r = await h.client.query({ type: 'getPropertyValues', props: [{ layer, path: 'text/perCharacter3D' }], time: 0, evaluated: false });
  if (!r.ok) throw new Error(r.error.message);
  const v = r.value.values[0]?.value;
  return v?.kind === 'bool' ? v.value : undefined;
}

async function textLayer(): Promise<string> {
  const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'text', name: 'Title', init: [] });
  await engineIdle();
  return layer;
}

describe('Text/3D presets', () => {
  it.each(['Flip Up 3D', 'Tumble In 3D', 'Rise From Depth', 'Hinge Swing 3D', 'Flip Away 3D', '3D Wave'])(
    '%s turns on 3D and per-character 3D',
    async (preset) => {
      const T = await textLayer();
      await h.run({ type: 'applyPreset', layers: [T], preset, time: sec(0) });
      await settleEdits();
      const m = documentMirror();
      expect(m.layer(T)?.switches.threeD).toBe(true);
      expect(await perCharacter3D(T)).toBe(true);
      expect(readAnimatorData((await docView()).getNode(T)!).length).toBeGreaterThan(0);
    },
    60_000,
  );

  it('a flat text preset leaves the layer 2D', async () => {
    const T = await textLayer();
    await h.run({ type: 'applyPreset', layers: [T], preset: 'Typewriter', time: sec(0) });
    await settleEdits();
    const m = documentMirror();
    expect(m.layer(T)?.switches.threeD).toBe(false);
    expect(await perCharacter3D(T)).not.toBe(true);
  }, 60_000);
});
