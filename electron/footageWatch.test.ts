/**
 * The footage watcher behind Edit Original's reload: directory watches,
 * the debounce, the atomic-save window, dedupe, the directory cap, teardown,
 * and the Edit Original open rules (sequence first frame, executables refused).
 */

const handled = new Map<string, (...args: unknown[]) => unknown>();

jest.mock('electron', () => ({ shell: { openPath: jest.fn(async () => '') } }));
jest.mock('./ipcGuard', () => ({
  handle: (channel: string, fn: (...args: unknown[]) => unknown) => handled.set(channel, fn),
}));

import {
  FootageWatcher,
  firstSequenceFrame,
  isOpenableFootage,
  pathKey,
  splitKey,
  stampChanged,
  type FileStamp,
  type FootageWatchDeps,
} from './footageWatch';
import { openFootageFile, registerFootageFileIpc } from './ipc/footageFiles';

/** A fake disk + fake fs.watch + manual clock. */
function harness(platform = 'win32', opts: { maxDirs?: number } = {}) {
  const disk = new Map<string, FileStamp>();
  const watches = new Map<string, { onEvent: (f: string | null) => void; onError: () => void; closed: boolean }>();
  const emitted: string[][] = [];
  let clock = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  const statCalls: string[] = [];
  const deps: FootageWatchDeps = {
    stat: async (p) => {
      statCalls.push(p);
      return disk.get(p) ?? null;
    },
    watchDir: (dir, onEvent, onError) => {
      const w = { onEvent, onError, closed: false };
      watches.set(dir, w);
      return { close: () => { w.closed = true; } };
    },
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: clock + ms, fn, id });
      return id;
    },
    clearTimeout: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    emit: (paths) => emitted.push(paths),
    platform,
    now: () => clock,
  };
  const w = new FootageWatcher(deps, { maxDirs: opts.maxDirs });
  /** Advance the clock, firing due timers, and let the stat queue drain. */
  const advance = async (ms: number): Promise<void> => {
    const until = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > until) break;
      timers.shift();
      clock = next.at;
      next.fn();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    clock = until;
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return { w, disk, watches, emitted, advance, statCalls };
}

describe('footage watcher', () => {
  it('normalises path keys per platform', () => {
    expect(pathKey('C:\\Footage\\Shot.PNG', 'win32')).toBe('c:/footage/shot.png');
    expect(pathKey('C:/Footage//Shot.png', 'win32')).toBe('c:/footage/shot.png');
    expect(pathKey('\\\\server\\share\\a.png', 'win32')).toBe('//server/share/a.png');
    expect(pathKey('/Users/me/A.png', 'darwin')).toBe('/users/me/a.png');
    expect(pathKey('/home/me/A.png', 'linux')).toBe('/home/me/A.png');
    expect(splitKey('c:/x.png')).toEqual({ dir: 'c:/', name: 'x.png' });
    expect(splitKey('c:/f/x.png')).toEqual({ dir: 'c:/f', name: 'x.png' });
    expect(splitKey('/x.png')).toEqual({ dir: '/', name: 'x.png' });
  });

  it('treats the first read as the baseline, then size / mtime / presence as change', () => {
    expect(stampChanged(undefined, { size: 1, mtimeMs: 1 })).toBe(false);
    expect(stampChanged({ size: 1, mtimeMs: 1 }, { size: 1, mtimeMs: 1 })).toBe(false);
    expect(stampChanged({ size: 1, mtimeMs: 1 }, { size: 1, mtimeMs: 2 })).toBe(true);
    expect(stampChanged({ size: 1, mtimeMs: 1 }, { size: 2, mtimeMs: 1 })).toBe(true);
    expect(stampChanged(null, { size: 1, mtimeMs: 1 })).toBe(true);
    expect(stampChanged({ size: 1, mtimeMs: 1 }, null)).toBe(true);
    expect(stampChanged(null, null)).toBe(false);
  });

  it('watches each folder once, and reports a save once after the 300 ms debounce', async () => {
    const h = harness();
    const a = 'C:\\Footage\\logo.psd';
    const b = 'C:\\Footage\\bg.png';
    h.disk.set(a, { size: 10, mtimeMs: 1 });
    h.disk.set(b, { size: 20, mtimeMs: 1 });
    await h.w.setPaths([a, b, a]);
    expect([...h.watches.keys()]).toEqual(['C:\\Footage']);
    expect(h.w.size()).toBe(2);

    // Photoshop writes in several chunks: a burst of events, one report.
    h.disk.set(a, { size: 11, mtimeMs: 2 });
    const dir = h.watches.get('C:\\Footage')!;
    dir.onEvent('logo.psd');
    await h.advance(100);
    dir.onEvent('LOGO.psd'); // case-folded on Windows
    await h.advance(100);
    dir.onEvent('logo.psd');
    await h.advance(299);
    expect(h.emitted).toEqual([]);
    await h.advance(1);
    expect(h.emitted).toEqual([[a]]);

    // An event for a file nobody watches does nothing.
    dir.onEvent('unrelated.txt');
    await h.advance(1000);
    expect(h.emitted).toHaveLength(1);
    // An event with no stamp change does nothing either.
    dir.onEvent('bg.png');
    await h.advance(1000);
    expect(h.emitted).toHaveLength(1);
  });

  it('flushes a continuously written file within the max wait', async () => {
    const h = harness();
    const a = 'C:\\F\\clip.wav';
    h.disk.set(a, { size: 1, mtimeMs: 1 });
    await h.w.setPaths([a]);
    const dir = h.watches.get('C:\\F')!;
    h.disk.set(a, { size: 2, mtimeMs: 2 });
    for (let t = 0; t < 2000; t += 100) {
      dir.onEvent('clip.wav');
      await h.advance(100);
    }
    expect(h.emitted).toEqual([[a]]);
  });

  it('rides out an atomic save (delete, then rename the temp over it)', async () => {
    const h = harness();
    const a = 'C:\\F\\comp.png';
    h.disk.set(a, { size: 1, mtimeMs: 1 });
    await h.w.setPaths([a]);
    const dir = h.watches.get('C:\\F')!;
    h.disk.delete(a);
    dir.onEvent('comp.png');
    await h.advance(300); // first flush: missing → retry
    expect(h.emitted).toEqual([]);
    h.disk.set(a, { size: 5, mtimeMs: 9 }); // rename lands
    dir.onEvent('comp.png');
    await h.advance(300);
    expect(h.emitted).toEqual([[a]]);
  });

  it('reports a file that really went away, after the retries', async () => {
    const h = harness('linux');
    const a = '/media/x.png';
    h.disk.set(a, { size: 1, mtimeMs: 1 });
    await h.w.setPaths([a]);
    h.disk.delete(a);
    h.watches.get('/media')!.onEvent('x.png');
    await h.advance(5000);
    expect(h.emitted).toEqual([[a]]);
  });

  it('treats an event without a file name as "something in this folder changed"', async () => {
    const h = harness('darwin');
    const a = '/Users/me/F/a.png';
    const b = '/Users/me/F/b.png';
    h.disk.set(a, { size: 1, mtimeMs: 1 });
    h.disk.set(b, { size: 1, mtimeMs: 1 });
    await h.w.setPaths([a, b]);
    h.disk.set(b, { size: 1, mtimeMs: 2 });
    h.watches.get('/Users/me/F')!.onEvent(null);
    await h.advance(300);
    expect(h.emitted).toEqual([[b]]);
  });

  it('check() re-stats everything (window focus) and does not double-report with a flush', async () => {
    const h = harness();
    const a = 'C:\\F\\a.png';
    h.disk.set(a, { size: 1, mtimeMs: 1 });
    await h.w.setPaths([a]);
    h.disk.set(a, { size: 1, mtimeMs: 2 });
    h.watches.get('C:\\F')!.onEvent('a.png');
    await expect(h.w.check()).resolves.toEqual([a]);
    await h.advance(1000);
    expect(h.emitted).toEqual([]); // the pending flush finds nothing new
    await expect(h.w.check()).resolves.toEqual([]);
  });

  it('caps the folder watches, priority folders first; check() still covers the rest', async () => {
    const h = harness('linux', { maxDirs: 2 });
    const paths = ['/a/1.png', '/b/2.png', '/c/3.png'];
    for (const p of paths) h.disk.set(p, { size: 1, mtimeMs: 1 });
    await h.w.setPaths(paths, ['/c/3.png']);
    expect([...h.watches.keys()].sort()).toEqual(['/a', '/c']);
    h.disk.set('/b/2.png', { size: 2, mtimeMs: 1 });
    await expect(h.w.check()).resolves.toEqual(['/b/2.png']);
  });

  it('closes a folder watch when its last path leaves, and every watch on dispose', async () => {
    const h = harness('linux');
    h.disk.set('/a/1.png', { size: 1, mtimeMs: 1 });
    h.disk.set('/b/2.png', { size: 1, mtimeMs: 1 });
    await h.w.setPaths(['/a/1.png', '/b/2.png']);
    expect(h.w.watchedDirs().sort()).toEqual(['/a', '/b']);
    await h.w.setPaths(['/b/2.png']); // item removed
    expect(h.watches.get('/a')!.closed).toBe(true);
    expect(h.watches.get('/b')!.closed).toBe(false);
    await h.w.setPaths([]); // project closed
    expect(h.watches.get('/b')!.closed).toBe(true);
    expect(h.w.watchedDirs()).toEqual([]);
    await h.w.setPaths(['/b/2.png']);
    h.w.dispose();
    expect([...h.watches.values()].every((w) => w.closed)).toBe(true);
    h.watches.get('/b')!.onEvent('2.png'); // a late event after dispose: ignored
    await h.advance(1000);
    expect(h.emitted).toEqual([]);
  });

  it('keeps baselines for paths that stay (no re-stat on an unrelated set change)', async () => {
    const h = harness('linux');
    h.disk.set('/a/1.png', { size: 1, mtimeMs: 1 });
    h.disk.set('/a/2.png', { size: 1, mtimeMs: 1 });
    await h.w.setPaths(['/a/1.png']);
    await h.w.setPaths(['/a/1.png', '/a/2.png']);
    expect(h.statCalls).toEqual(['/a/1.png', '/a/2.png']);
  });

  it('drops a dead folder watch without throwing', async () => {
    const h = harness('linux');
    h.disk.set('/a/1.png', { size: 1, mtimeMs: 1 });
    await h.w.setPaths(['/a/1.png']);
    h.watches.get('/a')!.onError();
    expect(h.w.watchedDirs()).toEqual([]);
    expect(h.watches.get('/a')!.closed).toBe(true);
  });

  it('handles non-ASCII paths like any other', async () => {
    const h = harness();
    const a = 'C:\\素材\\ロゴ.psd';
    h.disk.set(a, { size: 1, mtimeMs: 1 });
    await h.w.setPaths([a]);
    expect([...h.watches.keys()]).toEqual(['C:\\素材']);
    h.disk.set(a, { size: 2, mtimeMs: 2 });
    h.watches.get('C:\\素材')!.onEvent('ロゴ.psd');
    await h.advance(300);
    expect(h.emitted).toEqual([[a]]);
  });
});

describe('Edit Original open rules', () => {
  it('finds the first frame of a numbered sequence', () => {
    const entries = ['shot_0012.png', 'shot_0003.png', 'shot_0010.png', 'other_0001.png', 'shot_0004.jpg'];
    expect(firstSequenceFrame('shot_####.png', entries)).toBe('shot_0003.png');
    expect(firstSequenceFrame('shot_%04d.png', entries)).toBe('shot_0003.png');
    expect(firstSequenceFrame('shot_[####].png', entries)).toBe('shot_0003.png');
    expect(firstSequenceFrame('shot_0003.png', entries)).toBeNull();
    expect(firstSequenceFrame('none_####.png', entries)).toBeNull();
  });

  it('opens only media types: executables, scripts and anything else whose default action could run code are refused', () => {
    for (const p of ['C:\\a\\logo.psd', '/a/b.PNG', '/a/c.wav', '/a/model.glb', '/a/clip.MOV']) expect(isOpenableFootage(p)).toBe(true);
    for (const p of [
      'C:\\a\\x.exe', 'C:\\a\\x.BAT', '/a/x.sh', '/a/Thing.app', 'C:\\a\\x.lnk', 'C:\\a\\x.ps1',
      '/a/page.html', 'C:\\a\\help.chm', 'C:\\a\\m.docm', '/a/x.py', '/a/noext',
    ]) expect(isOpenableFootage(p)).toBe(false);
  });

  it('opens an existing file, reports missing / refused / the OS error', async () => {
    const opened: string[] = [];
    const deps = {
      openPath: async (p: string) => { opened.push(p); return p.endsWith('bad.png') ? 'No application is associated' : ''; },
      stat: async (p: string) => (p.includes('missing') ? null : { isFile: () => !p.endsWith('folder') }),
      readdir: async () => ['seq_002.png', 'seq_001.png'],
    };
    await expect(openFootageFile('C:\\m\\a.psd', deps)).resolves.toEqual({ ok: true, path: 'C:\\m\\a.psd' });
    await expect(openFootageFile('C:\\m\\missing.psd', deps)).resolves.toMatchObject({ ok: false, reason: 'missing' });
    await expect(openFootageFile('C:\\m\\folder', deps)).resolves.toMatchObject({ ok: false, reason: 'refused' });    await expect(openFootageFile('C:\\m\\evil.exe', deps)).resolves.toMatchObject({ ok: false, reason: 'refused' });
    await expect(openFootageFile('C:\\m\\bad.png', deps)).resolves.toEqual({ ok: false, reason: 'failed', path: 'C:\\m\\bad.png', error: 'No application is associated' });
    await expect(openFootageFile('', deps)).resolves.toMatchObject({ ok: false, reason: 'missing' });
    await expect(openFootageFile(42, deps)).resolves.toMatchObject({ ok: false, reason: 'missing' });
    const seq = await openFootageFile('/m/seq_###.png', deps);
    expect(seq).toEqual({ ok: true, path: expect.stringMatching(/seq_001\.png$/) });
    expect(opened).not.toContain('C:\\m\\evil.exe');
  });

  it('registers its three channels through the guarded handle', () => {
    handled.clear();
    registerFootageFileIpc();
    expect([...handled.keys()].sort()).toEqual(['footage:check', 'footage:watch', 'shell:openFile']);
  });
});
