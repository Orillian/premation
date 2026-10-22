/**
 * Effect Controls card names for plugin effects.
 *
 * Found on the RTX box (2026-10-13, second app instance): a loaded plugin's
 * effect card read "com.premation.samples.grade", "… 2" — the match name —
 * because the names were looked up in the built-in catalog only.
 */

import type { EffectInfo } from '@motion/engine-api';
import { effectDisplayNames, type Effect } from './effectCatalog';
import { setPluginEffectDefs } from './pluginEffectDefs';

const grade: EffectInfo = {
  matchName: 'com.premation.samples.grade',
  displayName: 'Color Grade (GPU)',
  category: 'Premation Samples',
  gpu: true,
  provider: 'com.premation.samples.grade',
  params: [],
  supportsFloat: true,
  audio: false,
  actions: [],
  groups: [],
};

afterEach(() => setPluginEffectDefs([]));

const named = (types: string[]): string[] => {
  const effects = types.map((type, i) => ({ id: `fx_${i}`, type }) as Effect);
  const names = effectDisplayNames(effects);
  return effects.map((e) => names.get(e.id)!);
};

it('names a loaded plugin effect by its plugin, numbered like a built-in', () => {
  setPluginEffectDefs([grade]);
  expect(named(['com.premation.samples.grade', 'com.premation.samples.grade'])).toEqual(['Color Grade (GPU)', 'Color Grade (GPU) 2']);
});

it('shows the type of an effect no loaded plugin provides (a missing plugin)', () => {
  expect(named(['com.premation.samples.grade'])).toEqual(['com.premation.samples.grade']);
});
