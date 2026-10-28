/**
 * The page side of Edit Original's reload: the project's footage set reaches
 * the Electron watcher (once per change), a change on disk becomes ONE
 * `reloadItems`, window focus re-checks, and uninstall stops every watch.
 */

import type { EditableItem } from './editOriginalLogic';

const items = new Map<string, EditableItem>();
let itemsListener: (() => void) | null = null;
const execute = jest.fn(async (_cmd: unknown) => ({ ok: true, value: {} }));
const notify = jest.fn();

jest.mock('@stores/documentMirror', () => ({
  hasDocumentMirror: () => true,
  documentMirror: () => ({
    get items() { return items; },
    item: (id: string) => items.get(id),
    subscribe: (_keys: string[], l: () => void) => { itemsListener = l; return () => { itemsListener = null; }; },
  }),
}));
jest.mock('@core/engine/engineInstance', () => ({ engine: () => ({ execute }), hasEngine: () => true }));
jest.mock('@stores/uiStore', () => ({ useUIStore: { getState: () => ({ notify }) } }));

import { installFootageWatchSync, noteEditedOriginal } from './footageWatchSync';

const footage = (id: string, path: string): EditableItem => ({ id, kind: 'footage', name: id, path, missing: false, proxyPath: '' });

describe('footage watch sync', () => {
  let changed: ((paths: string[]) => void) | null;
  const watch = jest.fn(async (_req: { paths: string[]; priority: string[] }) => undefined);
  const check = jest.fn(async () => [] as string[]);

  beforeEach(() => {
    jest.useFakeTimers();
    items.clear();
    execute.mockClear();
    watch.mockClear();
    check.mockClear();
    notify.mockClear();
    changed = null;
    (window as unknown as { motionEditor: unknown }).motionEditor = {
      footage: {
        watch,
        check,
        onChanged: (h: (paths: string[]) => void) => { changed = h; return () => { changed = null; }; },
      },
    };
  });
  afterEach(() => {
    jest.useRealTimers();
    delete (window as unknown as { motionEditor?: unknown }).motionEditor;
  });

  it('sends the footage set once per change, debounced, and empties it on uninstall', async () => {
    items.set('a', footage('a', 'C:\\f\\a.png'));
    const off = installFootageWatchSync();
    jest.advanceTimersByTime(300);
    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenLastCalledWith({ paths: ['C:\\f\\a.png'], priority: [] });

    // An items batch that changes nothing footage-wise: no IPC.
    itemsListener?.();
    jest.advanceTimersByTime(300);
    expect(watch).toHaveBeenCalledTimes(1);

    // Many batches (an import) → one re-send.
    items.set('b', footage('b', 'C:\\f\\b.png'));
    itemsListener?.();
    itemsListener?.();
    itemsListener?.();
    jest.advanceTimersByTime(300);
    expect(watch).toHaveBeenCalledTimes(2);

    // Edit Original on b: b becomes priority.
    noteEditedOriginal('C:\\f\\b.png');
    jest.advanceTimersByTime(300);
    expect(watch).toHaveBeenLastCalledWith({ paths: ['C:\\f\\a.png', 'C:\\f\\b.png'], priority: ['C:\\f\\b.png'] });

    // Item removed → its path leaves the set.
    items.delete('a');
    itemsListener?.();
    jest.advanceTimersByTime(300);
    expect(watch).toHaveBeenLastCalledWith({ paths: ['C:\\f\\b.png'], priority: ['C:\\f\\b.png'] });

    off();
    expect(watch).toHaveBeenLastCalledWith({ paths: [], priority: [] });
    expect(changed).toBeNull();
    expect(itemsListener).toBeNull();
  });

  it('turns a burst of change events for one file into one reloadItems', async () => {
    items.set('a', footage('a', 'C:\\f\\a.png'));
    items.set('a2', footage('a2', 'C:\\f\\a.png'));
    items.set('z', footage('z', 'C:\\f\\z.png'));
    const off = installFootageWatchSync();
    changed?.(['C:\\f\\a.png']);
    changed?.(['c:/F/A.png']);
    jest.advanceTimersByTime(100);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ type: 'reloadItems', items: ['a', 'a2'] });
    off();
  });

  it('re-checks on window focus (throttled) and reloads what moved', async () => {
    items.set('a', footage('a', 'C:\\f\\a.png'));
    check.mockResolvedValueOnce(['C:\\f\\a.png']);
    const off = installFootageWatchSync();
    jest.advanceTimersByTime(5000);
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus')); // within the throttle: ignored
    expect(check).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(100);
    expect(execute).toHaveBeenCalledWith({ type: 'reloadItems', items: ['a'] });
    off();
    window.dispatchEvent(new Event('focus'));
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('does nothing in the browser build (no bridge)', () => {
    delete (window as unknown as { motionEditor?: unknown }).motionEditor;
    const off = installFootageWatchSync();
    jest.advanceTimersByTime(1000);
    off();
    expect(watch).not.toHaveBeenCalled();
  });
});
