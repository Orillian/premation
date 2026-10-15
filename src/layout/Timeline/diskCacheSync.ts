/**
 * Preferences ▸ Media & Disk Cache → the engine.
 *
 * The disk tier of the preview cache is the engine's
 * (native/engine/src/render/disk_cache.hpp); the editor only says where and
 * how big, with `setCacheBudget { diskMegabytes, diskPath }` (0 MB or no path
 * = off). Sent when the window's engine client appears, on every change of
 * the three preferences, and again after an engine restart — a restarted
 * engine starts with its disk cache off, and finds the frames it wrote
 * before in the same folder.
 *
 * The folder is the user's choice, else main's default (`cache:defaultFolder`:
 * a machine-local cache location, never the roaming profile). No bridge (a
 * browser build, tests) = no default folder = off unless one is chosen.
 */

import type { Command } from '@motion/engine-api';
import {
  lastProcessEngineNotice,
  processEngine,
  subscribeProcessEngine,
} from '@core/engine/process/processEngine';
import { usePreferenceStore, type Preferences } from '@stores/preferenceStore';

export const DISK_CACHE_MIN_GB = 1;
export const DISK_CACHE_MAX_GB = 4096;

let defaultFolder: Promise<string | null> | null = null;

/** Main's default disk cache folder, asked once per window (null without the desktop bridge). */
export function defaultDiskCacheFolder(): Promise<string | null> {
  defaultFolder ??= (async () => {
    const ask = typeof window === 'undefined' ? undefined : window.motionEditor?.diskCache?.defaultFolder;
    if (!ask) return null;
    try {
      return (await ask()) || null;
    } catch {
      return null;
    }
  })();
  return defaultFolder;
}

type DiskCachePrefs = Pick<Preferences, 'diskCacheEnabled' | 'diskCacheFolder' | 'diskCacheMaxGb'>;

/** The `setCacheBudget` these preferences mean (`fallbackFolder` when none is chosen). */
export function diskCacheBudgetCommand(prefs: DiskCachePrefs, fallbackFolder: string | null): Extract<Command, { type: 'setCacheBudget' }> {
  const folder = prefs.diskCacheFolder || fallbackFolder || '';
  const gb = Math.min(DISK_CACHE_MAX_GB, Math.max(DISK_CACHE_MIN_GB, Math.round(prefs.diskCacheMaxGb) || DISK_CACHE_MIN_GB));
  const on = prefs.diskCacheEnabled && folder !== '';
  return { type: 'setCacheBudget', ramMegabytes: 0, diskMegabytes: on ? gb * 1024 : 0, diskPath: on ? folder : '' };
}

let installed = false;

/** Start following the preferences (idempotent). */
export function installDiskCacheSync(): void {
  if (installed) return;
  installed = true;
  let lastSent = '';
  let lastClient: unknown = null;
  let lastNotice: unknown = null;

  const send = async (): Promise<void> => {
    const client = processEngine();
    if (!client) return;
    const command = diskCacheBudgetCommand(usePreferenceStore.getState(), await defaultDiskCacheFolder());
    const signature = JSON.stringify(command);
    if (client === lastClient && signature === lastSent) return;
    lastClient = client;
    lastSent = signature;
    const res = await client.execute(command);
    if (!res.ok) {
      lastSent = '';  // try again on the next change
      console.warn(`[engine] setCacheBudget: ${res.error.code} ${res.error.message}`);
    }
  };

  usePreferenceStore.subscribe((s, prev) => {
    if (s.diskCacheEnabled === prev.diskCacheEnabled && s.diskCacheFolder === prev.diskCacheFolder && s.diskCacheMaxGb === prev.diskCacheMaxGb) return;
    void send();
  });
  subscribeProcessEngine(() => {
    // A restart notice: the new engine process has not heard it yet.
    const notice = lastProcessEngineNotice();
    if (notice !== lastNotice) {
      lastNotice = notice;
      lastSent = '';
    }
    void send();
  });
  void send();
}
