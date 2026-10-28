/**
 * Edit ▸ Edit Original (AE's Ctrl+E) and the footage reload behind it.
 *
 *   shell:openFile  — open a footage file in the OS default application for
 *                     its type (Photoshop for .psd, the image editor for .png).
 *                     A numbered-sequence pattern opens its first frame.
 *                     Executables and scripts are refused (`isOpenableFootage`):
 *                     opening one would RUN it.
 *   footage:watch   — replace this window's watched footage set
 *                     (electron/footageWatch.ts: directory watches, 300 ms
 *                     debounce, atomic-save aware). Changes are pushed back as
 *                     `footage:changed` with the paths as the page spelled them.
 *   footage:check   — re-stat the whole set now (the page calls it on window
 *                     focus — AE's reload-on-activate) and answer what moved.
 *
 * One watcher per window (webContents), closed when the window goes away; an
 * empty set (project closed) closes every directory watch. Registered through
 * `ipcGuard`'s `handle`, like every other channel.
 */

import { shell, type WebContents } from 'electron';
import { watch as fsWatch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { handle } from '../ipcGuard';
import { FootageWatcher, firstSequenceFrame, isOpenableFootage, sequencePattern, type FileStamp } from '../footageWatch';

export type OpenFileResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'missing' | 'refused' | 'failed'; path: string; error?: string };

export interface FootageFileDeps {
  openPath(p: string): Promise<string>;
  stat(p: string): Promise<{ isFile(): boolean } | null>;
  readdir(dir: string): Promise<string[]>;
}

const defaultDeps: FootageFileDeps = {
  openPath: (p) => shell.openPath(p),
  stat: async (p) => {
    try {
      return await stat(p);
    } catch {
      return null;
    }
  },
  readdir: async (dir) => {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  },
};

/** Open a footage file in its default application. Never throws. */
export async function openFootageFile(filePath: unknown, deps: FootageFileDeps = defaultDeps): Promise<OpenFileResult> {
  if (typeof filePath !== 'string' || filePath.trim() === '') return { ok: false, reason: 'missing', path: '' };
  let target = filePath;
  // `shot_####.png` / `shot_%04d.png`: the first frame on disk.
  const base = path.basename(target);
  if (sequencePattern(base)) {
    const first = firstSequenceFrame(base, await deps.readdir(path.dirname(target)));
    if (first) target = path.join(path.dirname(target), first);
  }
  if (!isOpenableFootage(target)) return { ok: false, reason: 'refused', path: target };
  const s = await deps.stat(target);
  if (!s || !s.isFile()) return { ok: false, reason: 'missing', path: target };
  try {
    const error = await deps.openPath(target);
    return error ? { ok: false, reason: 'failed', path: target, error } : { ok: true, path: target };
  } catch (e) {
    return { ok: false, reason: 'failed', path: target, error: e instanceof Error ? e.message : String(e) };
  }
}

async function stampOf(p: string): Promise<FileStamp | null> {
  try {
    const s = await stat(p);
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
  } catch {
    return null;
  }
}

const watchers = new Map<number, FootageWatcher>();

function watcherFor(sender: WebContents): FootageWatcher {
  const existing = watchers.get(sender.id);
  if (existing) return existing;
  const w = new FootageWatcher({
    stat: stampOf,
    watchDir: (dir, onEvent, onError) => {
      try {
        // Non-recursive; `persistent: false` so a watch never keeps the app alive on quit.
        const fw = fsWatch(dir, { persistent: false }, (_type, filename) => onEvent(filename ? String(filename) : null));
        fw.on('error', onError);
        return { close: () => fw.close() };
      } catch {
        return null;
      }
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    emit: (paths) => {
      if (!sender.isDestroyed()) sender.send('footage:changed', paths);
    },
    platform: process.platform,
  });
  watchers.set(sender.id, w);
  const id = sender.id;
  sender.once('destroyed', () => {
    watchers.get(id)?.dispose();
    watchers.delete(id);
  });
  return w;
}

function stringList(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const s of v) {
    if (typeof s === 'string' && s.length > 0 && s.length < 32768) out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/** Upper bound on one window's watched paths (a project's footage, with headroom). */
const MAX_PATHS = 20000;

export function registerFootageFileIpc(): void {
  handle('shell:openFile', (_e, filePath: string) => openFootageFile(filePath));

  handle('footage:watch', async (e, req: { paths?: unknown; priority?: unknown } | null) => {
    const paths = stringList(req?.paths, MAX_PATHS);
    if (paths.length === 0) {
      // Project closed / no footage: every directory watch of this window closes
      // (the watcher object stays, so its one `destroyed` hook is never re-added).
      await watchers.get(e.sender.id)?.setPaths([]);
      return;
    }
    await watcherFor(e.sender).setPaths(paths, stringList(req?.priority, MAX_PATHS));
  });

  handle('footage:check', async (e) => {
    const w = watchers.get(e.sender.id);
    return w ? w.check() : [];
  });
}
