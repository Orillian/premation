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
import os from 'node:os';
import path from 'node:path';
import { handle } from '../ipcGuard';

export function defaultDiskCacheFolder(): string {
  const name = app.getName() || 'Premation';
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, name, 'Disk Cache');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', name, 'Disk Cache');
  const xdg = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(xdg, name.toLowerCase(), 'disk-cache');
}

export function registerDiskCacheIpc(): void {
  handle('cache:defaultFolder', () => defaultDiskCacheFolder());
}
