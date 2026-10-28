import type { ItemInfo } from '@motion/engine-api';

const items = new Map<string, ItemInfo>();
jest.mock('@stores/documentMirror', () => ({
  documentMirror: () => ({ item: (id: string) => items.get(id) }),
}));
const edit = jest.fn((_label: string, _cmds: unknown) => Promise.resolve({ ok: true, value: [], revision: 1 }));
jest.mock('@core/engine/uiEdits', () => ({ edit: (label: string, cmds: unknown) => edit(label, cmds) }));
const startEngineJob = jest.fn();
jest.mock('@core/engine/engineJobs', () => ({ startEngineJob: (...args: unknown[]) => startEngineJob(...args) }));

import { setPanelAssetSelection } from '@core/composition/assetSelection';
import { useUIStore } from '@stores/uiStore';
import {
  buildProxyCommands,
  canCreateProxy,
  canCreateProxyForSelection,
  canSetProxyNoneForSelection,
  createProxies,
  proxyNoneEdits,
  proxyState,
  proxyToggleEdit,
  setProxyNone,
  toggleProxy,
  CREATE_PROXY_MOVIE_COMMAND,
  SET_PROXY_NONE_COMMAND,
} from './proxyCommands';

function item(id: string, over: Partial<ItemInfo> = {}): ItemInfo {
  return {
    id, kind: 'footage', name: `${id}.mp4`, label: 0, comment: '', path: `C:/f/${id}.mp4`, missing: false,
    width: 3840, height: 2160, duration: 0, hasVideo: true, hasAudio: false, hasAlpha: false,
    proxyPath: '', proxyEnabled: false, tags: [], codec: 'h264', audioChannels: 0, audioSampleRate: 0,
    colorProfile: '', fileBytes: 0, mediaType: 'video', alphaProbed: true, audioProbed: true, ...over,
  } as ItemInfo;
}

function put(...list: ItemInfo[]): void {
  items.clear();
  for (const i of list) items.set(i.id, i);
}

beforeEach(() => {
  edit.mockClear();
  startEngineJob.mockReset();
  setPanelAssetSelection([]);
});

describe('proxy state and targets', () => {
  it('reads none / off / on from the item', () => {
    expect(proxyState(undefined)).toBe('none');
    expect(proxyState(item('a'))).toBe('none');
    expect(proxyState(item('a', { proxyPath: 'p.mp4', proxyEnabled: false }))).toBe('off');
    expect(proxyState(item('a', { proxyPath: 'p.mp4', proxyEnabled: true }))).toBe('on');
  });

  it('offers Create Proxy only on video footage big enough to gain from one', () => {
    expect(canCreateProxy(item('a'))).toBe(true);
    expect(canCreateProxy(item('a', { width: 1280, height: 720 }))).toBe(false);
    expect(canCreateProxy(item('a', { mediaType: 'image' }))).toBe(false);
    expect(canCreateProxy(item('a', { missing: true }))).toBe(false);
    expect(canCreateProxy(item('a', { kind: 'composition' }))).toBe(false);
    expect(canCreateProxy(item('a', { width: 0, height: 0 }))).toBe(false);
  });

  it('toggles an existing proxy keeping its file, and clears it with no path', () => {
    expect(proxyToggleEdit(item('a'))).toBeNull();
    expect(proxyToggleEdit(item('a', { proxyPath: 'p.mp4', proxyEnabled: true }))).toEqual({ type: 'setProxy', item: 'a', path: 'p.mp4', enabled: false });
    expect(proxyToggleEdit(item('a', { proxyPath: 'p.mp4', proxyEnabled: false }))).toEqual({ type: 'setProxy', item: 'a', path: 'p.mp4', enabled: true });
    expect(proxyNoneEdits([item('a'), item('b')])).toEqual([
      { type: 'setProxy', item: 'a', enabled: false },
      { type: 'setProxy', item: 'b', enabled: false },
    ]);
  });
});

describe('command enable rules', () => {
  it('registers both commands with the AE ids the menu names', () => {
    expect(buildProxyCommands().map((c) => c.id)).toEqual([CREATE_PROXY_MOVIE_COMMAND, SET_PROXY_NONE_COMMAND]);
  });

  it('are off with nothing selected', () => {
    put(item('a'));
    const [create, none] = buildProxyCommands();
    expect(create!.enabled!()).toBe(false);
    expect(none!.enabled!()).toBe(false);
  });

  it('Create Proxy needs one qualifying item; Set Proxy None needs one with a proxy', () => {
    put(item('big'), item('small', { width: 640, height: 360 }), item('prox', { proxyPath: 'p.mp4', proxyEnabled: true }));
    expect(canCreateProxyForSelection(['small'])).toBe(false);
    expect(canCreateProxyForSelection(['small', 'big'])).toBe(true);
    expect(canSetProxyNoneForSelection(['big', 'small'])).toBe(false);
    expect(canSetProxyNoneForSelection(['big', 'prox'])).toBe(true);
    setPanelAssetSelection(['prox']);
    const [create, none] = buildProxyCommands();
    expect(none!.enabled!()).toBe(true);
    // A proxy existing does not stop a regenerate.
    expect(create!.enabled!()).toBe(true);
    expect(canCreateProxyForSelection(['gone'])).toBe(false);
  });
});

describe('actions', () => {
  it('the box click is one setProxy edit', async () => {
    put(item('a', { proxyPath: 'p.mp4', proxyEnabled: false }));
    await toggleProxy('a');
    expect(edit).toHaveBeenCalledWith('Use Proxy', { type: 'setProxy', item: 'a', path: 'p.mp4', enabled: true });
    await toggleProxy('missing-item');
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it('Set Proxy None clears only the items that have one, in one edit', async () => {
    put(item('a', { proxyPath: 'p.mp4', proxyEnabled: true }), item('b'));
    await setProxyNone(['a', 'b']);
    expect(edit).toHaveBeenCalledWith('Set Proxy None', [{ type: 'setProxy', item: 'a', enabled: false }]);
  });

  it('Create Proxy runs one engine proxy job per item as a tray job', async () => {
    put(item('a'), item('b', { width: 320, height: 240 }));
    startEngineJob.mockImplementation((_spec: unknown, opts: { onProgress?: (f: number, m: string) => void }) => {
      opts.onProgress?.(0.5, 'Encoding');
      return Promise.resolve({ id: 'j1', cancel: () => {}, done: Promise.resolve({ status: 'done', job: {}, result: { path: 'x' } }) });
    });
    await createProxies(['a', 'b']);
    expect(startEngineJob).toHaveBeenCalledTimes(1);
    expect(startEngineJob.mock.calls[0]![0]).toEqual({ kind: 'proxy', value: { item: 'a', outputFolder: '' } });
    const job = useUIStore.getState().jobs.find((j) => j.id === 'proxy:a');
    expect(job?.status).toBe('done');
  });

  it('reports an engine that runs no proxy jobs as a failed job', async () => {
    put(item('a'));
    startEngineJob.mockResolvedValue(null);
    await createProxies(['a']);
    expect(useUIStore.getState().jobs.find((j) => j.id === 'proxy:a')?.status).toBe('failed');
  });
});
