/**
 * The preview disk cache's default folder (Preferences ▸ Media & Disk Cache).
 *
 * The engine writes the frames (native/engine/src/render/disk_cache.hpp); the
 * page sends it a folder with `setCacheBudget`. When the user has not chosen
 * one, this is it: a machine-local cache location, never the roaming profile
 * — Windows' %LOCALAPPDATA% (AppData\Roaming would sync gigabytes of frames
 * between machines), macOS' ~/Library/Caches, Linux' $XDG_CACHE_HOME. The
 * engine adds its own `premation-frames-v1` subfolder and only ever deletes
 * files there.
 */

import { app } from 'electron';
import { existsSync, readdirSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handle } from '../ipcGuard';

/** One volume the Cache & Memory panel offers as a cache location. */
export interface CacheDrive {
  /** The volume's root (`C:\`, `/`, `/Volumes/Scratch`). */
  root: string;
  freeBytes: number;
  totalBytes: number;
}

/** The packaged app's name (electron-builder `productName`). A dev run's `app.getName()` is "Electron" — every Electron app in development shares that folder. */
const PRODUCT = 'Premation';

export function defaultDiskCacheFolder(): string {
  const name = app.isPackaged ? app.getName() || PRODUCT : PRODUCT;
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, name, 'Disk Cache');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', name, 'Disk Cache');
  const xdg = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(xdg, name.toLowerCase(), 'disk-cache');
}

/** Candidate volume roots on this machine (existence only; sizes come from statfs). */
function volumeRoots(): string[] {
  if (process.platform === 'win32') {
    const roots: string[] = [];
    // C… Z: A and B are floppy letters, and probing an empty removable drive can stall.
    for (let c = 67; c <= 90; c++) {
      const root = `${String.fromCharCode(c)}:\\`;
      if (existsSync(root)) roots.push(root);
    }
    return roots;
  }
  const under = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
    } catch {
      return [];
    }
  };
  if (process.platform === 'darwin') return ['/', ...under('/Volumes').filter((v) => v !== '/Volumes/Macintosh HD')];
  return ['/', ...under('/mnt'), ...under(path.join('/media', os.userInfo().username))];
}

/** Each volume's free and total space; one that cannot be read (an empty card reader) is left out. */
export async function listCacheDrives(): Promise<CacheDrive[]> {
  const out: CacheDrive[] = [];
  for (const root of volumeRoots()) {
    try {
      const s = await statfs(root);
      const totalBytes = Number(s.blocks) * Number(s.bsize);
      if (!(totalBytes > 0)) continue;
      out.push({ root, freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes });
    } catch {
      // Not mounted / no media: not a place to put a cache.
    }
  }
  return out;
}

export function registerDiskCacheIpc(): void {
  handle('cache:defaultFolder', () => defaultDiskCacheFolder());
  handle('cache:drives', () => listCacheDrives());
}
