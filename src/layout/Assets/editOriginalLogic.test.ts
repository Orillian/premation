/**
 * Edit Original's pure rules: which items it opens (enable state), and how a
 * batch of changed files becomes one reload per item.
 */

import {
  editOriginalTargets,
  footagePathKey,
  footageWatchPlan,
  isDiskPath,
  isEditableOriginal,
  itemsForChangedPaths,
  ReloadBatcher,
  type EditableItem,
} from './editOriginalLogic';

const footage = (id: string, path: string, extra: Partial<EditableItem> = {}): EditableItem => ({
  id, kind: 'footage', name: id, path, missing: false, proxyPath: '', ...extra,
});

const ITEMS: Record<string, EditableItem> = {
  logo: footage('logo', 'C:\\art\\logo.psd'),
  clip: footage('clip', 'C:\\media\\clip.mp4', { proxyPath: 'C:\\proxies\\clip_proxy.mp4' }),
  blob: footage('blob', ''),
  solid: { id: 'solid', kind: 'solid', name: 'Red Solid', path: '', missing: false, proxyPath: '' },
  comp: { id: 'comp', kind: 'composition', name: 'Pre-comp', path: '', missing: false, proxyPath: '' },
  offline: footage('offline', 'D:\\gone\\shot.png', { missing: true }),
};
const LAYER_SOURCE: Record<string, string | undefined> = {
  L1: 'logo', L2: 'logo', L3: 'clip', LSolid: 'solid', LText: undefined, LPre: 'comp',
};

function q(layerIds: string[], panelIds: string[], panelFocused = false) {
  return editOriginalTargets({
    layerIds,
    panelIds,
    panelFocused,
    layerSource: (id) => LAYER_SOURCE[id],
    item: (id) => ITEMS[id],
  }).map((i) => i.id);
}

describe('Edit Original targets (enable rules)', () => {
  it('accepts footage with a file, never solids, text, shapes, precomps or in-project blobs', () => {
    expect(isEditableOriginal(ITEMS.logo)).toBe(true);
    expect(isEditableOriginal(ITEMS.offline)).toBe(true); // tried, then reported missing
    expect(isEditableOriginal(ITEMS.blob)).toBe(false);
    expect(isEditableOriginal(ITEMS.solid)).toBe(false);
    expect(isEditableOriginal(ITEMS.comp)).toBe(false);
    expect(isEditableOriginal(undefined)).toBe(false);
  });

  it('knows a file path from a URL or blob reference', () => {
    for (const p of ['C:\\a\\b.png', 'C:/a/b.png', '\\\\srv\\share\\b.png', '/Users/me/b.png', 'relative/b.png', 'C:\\素材\\ロゴ.psd']) {
      expect(isDiskPath(p)).toBe(true);
    }
    for (const p of ['', '  ', 'motion-blob:abc123', 'blob:http://x/1', 'data:image/png;base64,AA', 'https://x/y.png', 'local-file://C:/a.png']) {
      expect(isDiskPath(p)).toBe(false);
    }
  });

  it('opens each item once however many selected layers use it', () => {
    expect(q(['L1', 'L2', 'L3', 'L1'], [])).toEqual(['logo', 'clip']);
  });

  it('is disabled (empty) for solid / text / precomp layers', () => {
    expect(q(['LSolid', 'LText', 'LPre'], [])).toEqual([]);
  });

  it('prefers the Assets panel selection while that panel has focus', () => {
    expect(q(['L3'], ['logo'], true)).toEqual(['logo']);
    expect(q(['L3'], ['logo'], false)).toEqual(['clip']);
  });

  it('falls back to the panel selection when no selected layer has a file', () => {
    expect(q(['LSolid'], ['clip', 'blob'])).toEqual(['clip']);
    expect(q([], [])).toEqual([]);
  });
});

describe('footage watch plan', () => {
  it('watches every footage file and proxy once, priority files first', () => {
    const plan = footageWatchPlan(Object.values(ITEMS), ['c:/ART/logo.psd', 'C:\\nope.png'], true);
    expect(plan.paths).toEqual(['C:\\art\\logo.psd', 'C:\\media\\clip.mp4', 'C:\\proxies\\clip_proxy.mp4', 'D:\\gone\\shot.png'].sort());
    expect(plan.priority).toEqual(['C:\\art\\logo.psd']);
  });

  it('dedupes two items on one file and is stable (same signature → no IPC)', () => {
    const a = [footage('a', 'C:\\x\\same.png'), footage('b', 'c:/X/SAME.png')];
    const p1 = footageWatchPlan(a, [], true);
    expect(p1.paths).toHaveLength(1);
    expect(footageWatchPlan([...a].reverse(), [], true).paths).toHaveLength(1);
    expect(footageWatchPlan(a, [], true).signature).toBe(p1.signature);
    expect(footageWatchPlan([], [], true).paths).toEqual([]);
  });

  it('case-folds only where the file system does', () => {
    expect(footagePathKey('C:\\A\\B.png', true)).toBe('c:/a/b.png');
    expect(footagePathKey('/A/B.png', false)).toBe('/A/B.png');
    expect(footagePathKey('\\\\srv\\Share\\b.png', true)).toBe('//srv/share/b.png');
  });
});

describe('changed files → reload', () => {
  const items = [
    footage('a', 'C:\\x\\logo.psd'),
    footage('a2', 'C:\\x\\logo.psd'), // a second item on the same file reloads too
    footage('clip', 'C:\\m\\clip.mp4', { proxyPath: 'C:\\p\\clip_proxy.mp4' }),
    footage('other', 'C:\\m\\other.mp4'),
  ];

  it('maps paths (any spelling) to items, each once', () => {
    expect(itemsForChangedPaths(items, ['c:/X/LOGO.psd', 'C:\\x\\logo.psd'], true)).toEqual(['a', 'a2']);
  });

  it('reloads an item when its proxy file changes', () => {
    expect(itemsForChangedPaths(items, ['C:\\p\\clip_proxy.mp4', 'C:\\m\\clip.mp4'], true)).toEqual(['clip']);
  });

  it('ignores unknown paths and empty batches', () => {
    expect(itemsForChangedPaths(items, ['C:\\elsewhere.png'], true)).toEqual([]);
    expect(itemsForChangedPaths(items, [], true)).toEqual([]);
  });

  it('batches racing reload requests into one engine call, each id once', () => {
    jest.useFakeTimers();
    try {
      const calls: string[][] = [];
      const b = new ReloadBatcher((ids) => calls.push(ids), 50);
      b.add(['a', 'clip']);
      b.add(['a']); // the focus check racing the watch event
      b.add([]);
      jest.advanceTimersByTime(49);
      expect(calls).toEqual([]);
      jest.advanceTimersByTime(1);
      expect(calls).toEqual([['a', 'clip']]);
      b.add(['other']);
      b.dispose();
      jest.advanceTimersByTime(100);
      expect(calls).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
