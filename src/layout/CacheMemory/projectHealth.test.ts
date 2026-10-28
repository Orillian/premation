import type { ItemInfo, LayerError, LayerInfo } from '@motion/engine-api';
import { compFootageFacts, projectHealth, MANY_VIDEO_LAYERS, type CompFootageFacts, type HealthInput } from './projectHealth';

function item(id: string, over: Partial<ItemInfo> = {}): ItemInfo {
  return {
    id, kind: 'footage', name: id, label: 0, comment: '', path: '', missing: false, width: 1920, height: 1080,
    duration: 0, hasVideo: true, hasAudio: false, hasAlpha: false, proxyPath: '', proxyEnabled: false, tags: [],
    codec: '', audioChannels: 0, audioSampleRate: 0, colorProfile: '', fileBytes: 0, mediaType: 'video',
    alphaProbed: true, audioProbed: true, ...over,
  } as ItemInfo;
}

function layer(id: string, source: string | undefined, over: Partial<LayerInfo['switches']> = {}): LayerInfo {
  return { id, source, switches: { visible: true, guide: false, ...over }, children: [] } as unknown as LayerInfo;
}

const facts = (over: Partial<CompFootageFacts> = {}): CompFootageFacts => ({
  videoLayers: 0, videoSources: 0, largeWithoutProxy: [], proxiesOff: [], proxiesOn: 0, missing: 0, errors: [], ...over,
});

const input = (over: Partial<HealthInput> = {}): HealthInput => ({
  readout: null, memory: { kind: 'healthy' }, footage: facts(), useProxies: true,
  frameMs: 10, frameBudgetMs: 1000 / 30, cache: { cached: 0, total: 100 }, ...over,
});

describe('compFootageFacts', () => {
  const items = new Map<string, ItemInfo>([
    ['uhd', item('uhd', { width: 3840, height: 2160 })],
    ['uhdProxyOff', item('uhdProxyOff', { width: 3840, height: 2160, proxyPath: 'p.mp4' })],
    ['hdProxyOn', item('hdProxyOn', { proxyPath: 'q.mp4', proxyEnabled: true })],
    ['still', item('still', { mediaType: 'image', width: 6000, height: 4000 })],
    ['gone', item('gone', { missing: true, width: 3840, height: 2160 })],
    ['comp', item('comp', { kind: 'composition' })],
  ]);
  const get = (id: string): ItemInfo | undefined => items.get(id);

  it('counts visible video layers, distinct files, missing and proxy states of what the comp uses', () => {
    const f = compFootageFacts([
      layer('1', 'uhd'), layer('2', 'uhd'), layer('3', 'uhdProxyOff'), layer('4', 'hdProxyOn'),
      layer('5', 'still'), layer('6', 'gone'), layer('7', 'comp'), layer('8', undefined),
      layer('9', 'uhd', { visible: false }), layer('10', 'uhd', { guide: true }), undefined,
    ], get, []);
    expect(f.videoLayers).toBe(5); // 1, 2, 3, 4, 6 — hidden and guide layers decode nothing
    expect(f.videoSources).toBe(4);
    expect(f.largeWithoutProxy).toEqual(['uhd']); // a missing file cannot be transcoded
    expect(f.proxiesOff).toEqual(['uhdProxyOff']);
    expect(f.proxiesOn).toBe(1);
    expect(f.missing).toBe(1);
  });
});

describe('projectHealth', () => {
  it('is ok with nothing to say', () => {
    expect(projectHealth(input())).toEqual({ tone: 'ok', findings: [] });
    expect(projectHealth(input({ footage: null, frameMs: 500 })).tone).toBe('ok');
  });

  it('turns red on layer errors, counting layers not errors', () => {
    const errors: LayerError[] = [
      { layer: 'a', stage: 'effect', message: 'x' },
      { layer: 'a', stage: 'expression', message: 'y' },
      { layer: 'b', stage: 'decode', message: 'z' },
    ];
    const h = projectHealth(input({ footage: facts({ errors, largeWithoutProxy: ['u'] }) }));
    expect(h.tone).toBe('bad');
    expect(h.findings[0]).toMatchObject({ kind: 'layerErrors', n: 2 });
    expect(h.findings.map((f) => f.kind)).toContain('largeWithoutProxy');
  });

  it('suggests proxies for 4K footage and Use Proxies when it is off', () => {
    const h = projectHealth(input({ useProxies: false, footage: facts({ largeWithoutProxy: ['u1', 'u2'], proxiesOn: 3 }) }));
    expect(h.tone).toBe('warn');
    expect(h.findings).toEqual(expect.arrayContaining([
      { kind: 'largeWithoutProxy', tone: 'warn', n: 2, items: ['u1', 'u2'] },
      { kind: 'useProxiesOff', tone: 'warn', n: 3 },
    ]));
    expect(projectHealth(input({ useProxies: true, footage: facts({ proxiesOn: 3 }) })).findings).toEqual([]);
  });

  it('warns from the video-layer threshold up', () => {
    expect(projectHealth(input({ footage: facts({ videoLayers: MANY_VIDEO_LAYERS - 1 }) })).findings).toEqual([]);
    expect(projectHealth(input({ footage: facts({ videoLayers: MANY_VIDEO_LAYERS }) })).findings[0]?.kind).toBe('manyVideoLayers');
  });

  it('maps the memory verdict: growing is red, pressure amber', () => {
    expect(projectHealth(input({ memory: { kind: 'growing', growthPerMin: 1 } })).findings[0]).toMatchObject({ kind: 'memoryGrowing', tone: 'bad' });
    expect(projectHealth(input({ memory: { kind: 'pressure', pressure: 'machine' } })).findings[0]?.kind).toBe('machineLow');
    expect(projectHealth(input({ memory: { kind: 'pressure', pressure: 'ramBudget' } })).findings[0]?.kind).toBe('ramFull');
  });

  it('suggests caching only when frames are slower than real time and not all cached', () => {
    expect(projectHealth(input({ frameMs: 80 })).findings[0]).toMatchObject({ kind: 'slowUncached', n: 80 });
    expect(projectHealth(input({ frameMs: 80, cache: { cached: 100, total: 100 } })).findings).toEqual([]);
    expect(projectHealth(input({ frameMs: 20 })).findings).toEqual([]);
    // The status dot reads no coverage: a slow frame alone is enough there.
    expect(projectHealth(input({ frameMs: 80, cache: null })).findings[0]?.kind).toBe('slowUncached');
  });

  it('lists red before amber', () => {
    const h = projectHealth(input({ memory: { kind: 'growing' }, footage: facts({ missing: 1, errors: [{ layer: 'a', stage: 'effect', message: '' }] }) }));
    expect(h.findings.map((f) => f.tone)).toEqual(['bad', 'bad', 'warn']);
  });
});
