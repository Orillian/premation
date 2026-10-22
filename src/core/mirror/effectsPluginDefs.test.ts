/**
 * mirrorEffects and plugin definitions that arrive after the stack was read.
 *
 * Found on the RTX box (2026-10-13, second app instance): after a restart the
 * Grade Map card showed its defaults ("rgb", no LUT) although the document held
 * "r" and a .cube — the stack was read (and cached per tree record) before the
 * engine's plugin effect list arrived, and the tree record did not change after.
 */

import type { EffectInfo, PropertyInfo } from '@motion/engine-api';
import { setPluginEffectDefs } from '@core/inspector/pluginEffectDefs';
import { mirrorEffects } from './effects';

const node = (path: string, matchName: string, value?: PropertyInfo['value'], children: string[] = []): PropertyInfo =>
  ({ path, name: matchName, matchName, kind: value ? 'property' : 'group', valueType: value ? 'string' : 'none', children, enabled: true, ...(value ? { value } : {}) } as unknown as PropertyInfo);

const tree = {
  layer: 'layer_1',
  nodes: new Map<string, PropertyInfo>([
    ['effects', node('effects', 'effects', undefined, ['effects/fx_1'])],
    ['effects/fx_1', node('effects/fx_1', 'com.acme.grade', undefined, ['effects/fx_1/p1'])],
    ['effects/fx_1/p1', node('effects/fx_1/p1', 'p1', { kind: 'string', value: 'r' })],
  ]),
};

const grade: EffectInfo = {
  matchName: 'com.acme.grade', displayName: 'Grade', category: 'Acme', gpu: false, provider: 'com.acme.grade', supportsFloat: true, audio: false, actions: [], groups: [],
  params: [{ matchName: 'p1', name: 'Channels', kind: 'text', valueType: 'string', defaultValue: { kind: 'string', value: 'rgb' }, choices: [] } as unknown as EffectInfo['params'][number]],
};

afterEach(() => setPluginEffectDefs([]));

test('a plugin effect read before its definition is read again once the definition arrives', () => {
  setPluginEffectDefs([]);
  expect(mirrorEffects(tree)[0]?.params).toBeUndefined();
  setPluginEffectDefs([grade]);
  expect(mirrorEffects(tree)[0]?.params).toEqual({ p1: 'r' });
});
