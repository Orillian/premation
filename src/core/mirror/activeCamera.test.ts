/**
 * `activeCameraIdOf`: the topmost enabled camera whose bar holds the time —
 * the renderer's rule, read from mirror headers.
 */

import type { LayerInfo } from '@motion/engine-api';
import { secondsToFlicks } from '@motion/engine-api';
import { activeCameraIdOf } from './activeCamera';
import type { MirrorCompLayersRead } from './compLayers';

function layer(id: string, kind: LayerInfo['kind'], extra: Partial<LayerInfo> = {}, visible = true, bar?: [number, number]): LayerInfo {
  return {
    id, comp: 'c', kind, name: id, children: [], hasVideo: true, hasAudio: false, markers: [], comment: '', generator: '',
    pinned: [], effectCount: 0, shapeType: '', managedBy: '', mographId: '', svg: 'none',
    switches: { threeD: false, visible } as LayerInfo['switches'],
    timing: (bar ? { inPoint: secondsToFlicks(bar[0]), outPoint: secondsToFlicks(bar[1]) } : {}) as LayerInfo['timing'],
    blendMode: 'normal' as LayerInfo['blendMode'], matte: {} as LayerInfo['matte'],
    ...extra,
  };
}

function fake(order: string[], layers: LayerInfo[]): MirrorCompLayersRead {
  const map = new Map(layers.map((l) => [l.id, l]));
  return { layer: (id) => map.get(id), comp: (id) => (id === 'c' ? { layers: order } : undefined), layerIds: () => [...map.keys()] };
}

describe('activeCameraIdOf', () => {
  it('is null without a camera', () => {
    expect(activeCameraIdOf(fake(['a'], [layer('a', 'shape')]), 'c', 0)).toBeNull();
  });

  it('takes the topmost enabled camera (the stack lists top first)', () => {
    const m = fake(['top', 'low', 'a'], [layer('top', 'camera'), layer('low', 'camera'), layer('a', 'shape')]);
    expect(activeCameraIdOf(m, 'c', 1)).toBe('top');
  });

  it('skips a hidden camera and one outside its in/out bar', () => {
    const m = fake(
      ['hidden', 'late', 'early', 'always'],
      [
        layer('hidden', 'camera', {}, false),
        layer('late', 'camera', {}, true, [5, 10]),
        layer('early', 'camera', {}, true, [0, 2]),
        layer('always', 'camera'),
      ],
    );
    expect(activeCameraIdOf(m, 'c', 1)).toBe('early');
    expect(activeCameraIdOf(m, 'c', 3)).toBe('always');
    expect(activeCameraIdOf(m, 'c', 7)).toBe('late');
  });
});
