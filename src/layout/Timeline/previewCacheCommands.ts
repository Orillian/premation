/**
 * The three preview-cache actions, as first-class COMMANDS.
 *
 * Registered from this module rather than from the app's boot block, the same
 * way `timelineFitCommands` does it: the handlers, the ids and the shortcut
 * re-scan ship as one unit, so nothing else has to be edited to add or remove
 * them. Registration is idempotent (the registry replaces by id).
 *
 * ## The cache is the engine's
 *
 * The frames the viewport shows are drawn by `premation-engine`, and so is the
 * cache they come back from: a frame cache in VIDEO MEMORY, keyed by content,
 * filled by every exact frame the engine draws (playback, a scrub, a parked
 * playhead) and evicted least-recently-used at a budget the engine sizes from
 * the graphics adapter — and below it AE's DISK CACHE, the same frames in a
 * folder on disk (Preferences ▸ Media & Disk Cache, diskCacheSync.ts), which
 * outlives the session. What these commands can do is what the engine API
 * offers (`play { cacheOnly }`, `purgeCache`, `getCacheCoverage`):
 *
 *   Purge RAM Preview     `purgeCache { kind: 'ram' }` — empties the VRAM cache.
 *   Purge Disk Cache      `purgeCache { kind: 'disk' }` — deletes the disk
 *                         cache's frames; enabled while it holds some.
 *   Purge All Memory & Disk Cache   both (never `kind: 'all'`, which also
 *                         names the undo history).
 *   Cache Work Area Now   `play { cacheFirst, cacheOnly }` — the engine draws
 *                         every frame of the span into its cache, then stops
 *                         with the playhead back where it was. The transport
 *                         reads `caching` meanwhile; Space or a click on the
 *                         ruler ends the fill with what is stored.
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { getShortcutManager } from '@core/commands/ShortcutManager';
import { engine } from '@core/engine/engineInstance';
import { useUIStore } from '@stores/uiStore';
import { t } from '@core/i18n';
import { engineCacheSnapshot } from './engineCacheCoverage';
import { formatCacheMb, previewCacheStats } from './previewCacheStats';

export const PREVIEW_CACHE_WORK_AREA_COMMAND = asCommandId('preview.cacheWorkArea');
export const PREVIEW_PURGE_RAM_COMMAND = asCommandId('preview.purgeRam');
export const PREVIEW_PURGE_DISK_COMMAND = asCommandId('preview.purgeDisk');
export const PREVIEW_PURGE_ALL_COMMAND = asCommandId('preview.purgeAllCaches');

const MB = 1024 * 1024;

/**
 * Why "Cache Work Area Now" cannot run, where it cannot: with no engine
 * viewport open there is nowhere to store frames. Shown wherever the action is
 * offered (the lane button's tooltip, the menu row, the toast).
 */
export function cacheWorkAreaUnavailable(): string {
  return t('timeline.cache.workAreaUnavailable', 'The preview cache fills from the viewport — open a composition to cache it.');
}

/** Why "Purge Disk Cache" has nothing to do. */
export function diskCacheUnavailable(): string {
  return t('timeline.cache.diskUnavailable', 'The disk cache is empty (or off in Preferences ▸ Media & Disk Cache).');
}

/**
 * Whether the engine can be asked to fill its frame cache now: there is a
 * composition with frames to store. A function so the button, the menu row
 * and the command ask one place.
 */
export function canCacheWorkArea(): boolean {
  return previewCacheStats().total > 0;
}

/** Whether the engine reports a disk tier with something in it. */
export function hasEngineDiskCache(): boolean {
  return engineCacheSnapshot().diskBytes > 0;
}

/**
 * Confirm-less feedback. None of the three needs a dialog: both purges cost
 * render time rather than user data — a modal in front of them would be more
 * expensive than the mistake it prevents.
 */
function toast(message: string, level: 'info' | 'success' | 'warning' = 'info'): void {
  useUIStore.getState().notify({ level, message, durationMs: 3200 });
}

/**
 * "Cache Work Area Now". Either the span is already in the engine's cache, or
 * the engine is asked to fill it (`play { cacheFirst, cacheOnly }`): it draws
 * the span frame by frame, then stops with the playhead where it was. Callers
 * that offer the action unconditionally (the Preview menu) reach this, so it
 * answers rather than failing silently.
 */
export function cacheWorkAreaNow(): void {
  const stats = previewCacheStats();
  if (stats.total === 0) {
    toast(t('timeline.cache.noFrames', 'Nothing to cache — this composition has no frames'), 'warning');
    return;
  }
  if (stats.cached >= stats.total) {
    toast(stats.workArea
      ? t('timeline.cache.workAreaCached', 'Work area is already cached')
      : t('timeline.cache.compositionCached', 'Composition is already cached'), 'info');
    return;
  }
  void engine()
    .execute({ type: 'play', rate: 1, range: stats.workArea ? 'workArea' : 'all', audio: false, cacheFirst: true, cacheOnly: true })
    .then((res) => {
      if (!res.ok) {
        toast(stats.workArea
          ? t('timeline.cache.workAreaFailed', 'Could not cache the work area: {error}', { error: res.error.message })
          : t('timeline.cache.compositionFailed', 'Could not cache the composition: {error}', { error: res.error.message }), 'warning');
      }
    });
}

export function purgeRamPreview(): void {
  // The size is the last sample the cache bars took — it can be stale (nothing
  // polls with the timeline hidden), so the purge is sent whatever it says and
  // only the wording depends on it.
  const held = engineCacheSnapshot().ramBytes / MB;
  void engine().execute({ type: 'purgeCache', kind: 'ram' }).then((res) => {
    if (!res.ok) {
      toast(t('timeline.cache.purgeRamFailed', 'Could not purge the preview cache: {error}', { error: res.error.message }), 'warning');
      return;
    }
    toast(held > 0
      ? t('timeline.cache.purgedRamSize', 'Purged {size} from the preview cache', { size: formatCacheMb(held) })
      : t('timeline.cache.purgedRam', 'Purged the preview cache'), 'success');
  });
}

export function purgeDiskCache(): void {
  if (!hasEngineDiskCache()) {
    toast(diskCacheUnavailable(), 'info');
    return;
  }
  const held = engineCacheSnapshot().diskBytes / MB;
  void engine().execute({ type: 'purgeCache', kind: 'disk' }).then((res) => {
    if (!res.ok) {
      toast(t('timeline.cache.purgeDiskFailed', 'Could not purge the disk cache: {error}', { error: res.error.message }), 'warning');
      return;
    }
    toast(t('timeline.cache.purgedDiskSize', 'Purged {size} of disk cache', { size: formatCacheMb(held) }), 'success');
  });
}

/** AE's Edit ▸ Purge ▸ All Memory & Disk Cache: the VRAM cache and the disk cache. */
export function purgeAllCaches(): void {
  const client = engine();
  void Promise.all([
    client.execute({ type: 'purgeCache', kind: 'ram' }),
    client.execute({ type: 'purgeCache', kind: 'disk' }),
  ]).then(([ram, disk]) => {
    if (!ram.ok || !disk.ok) {
      const err = !ram.ok ? ram.error : !disk.ok ? disk.error : null;
      toast(t('timeline.cache.purgeAllFailed', 'Could not purge the caches: {error}', {
        error: err?.message ?? t('timeline.cache.unknownError', 'unknown error'),
      }), 'warning');
      return;
    }
    toast(t('timeline.cache.purgedAll', 'Purged the preview cache and the disk cache'), 'success');
  });
}

export function buildPreviewCacheCommands(): ReadonlyArray<Command> {
  return [
    {
      id: PREVIEW_CACHE_WORK_AREA_COMMAND,
      label: t('timeline.cache.cacheWorkAreaNow', 'Cache Work Area Now'),
      description: t('timeline.cache.cacheWorkAreaNowDescription', 'Pre-render the work area (or the whole composition when none is set) into the preview cache.'),
      icon: 'refresh',
      enabled: canCacheWorkArea,
      execute: () => {
        cacheWorkAreaNow();
      },
    },
    {
      id: PREVIEW_PURGE_RAM_COMMAND,
      label: t('timeline.cache.purgeRamPreview', 'Purge RAM Preview'),
      description: t('timeline.cache.purgeRamPreviewDescription', 'Empty the preview frame cache the engine holds in video memory. Frames are drawn again as the playhead reaches them.'),
      icon: 'trash',
      execute: () => {
        purgeRamPreview();
      },
    },
    {
      id: PREVIEW_PURGE_DISK_COMMAND,
      label: t('timeline.cache.purgeDiskCache', 'Purge Disk Cache'),
      description: t('timeline.cache.purgeDiskCacheDescription', 'Delete the frames the disk cache holds. They are drawn and written again as the playhead reaches them.'),
      icon: 'trash',
      enabled: hasEngineDiskCache,
      execute: () => {
        purgeDiskCache();
      },
    },
    {
      id: PREVIEW_PURGE_ALL_COMMAND,
      label: t('timeline.cache.purgeAll', 'Purge All Memory & Disk Cache'),
      description: t('timeline.cache.purgeAllDescription', "Empty the preview frame cache in video memory and delete the disk cache's frames."),
      icon: 'trash',
      execute: () => {
        purgeAllCaches();
      },
    },
  ];
}

let installed = false;

/** Register all three. Safe to call repeatedly; the first call does the work. */
export function installPreviewCacheCommands(): void {
  if (installed) return;
  installed = true;
  const registry = getCommandRegistry();
  for (const command of buildPreviewCacheCommands()) registry.register(command);
  // Bindings are a snapshot of the registry taken at boot, so a command
  // registered later is inert until the manager re-reads it. None of these
  // carry a chord today; the re-scan keeps that free to change.
  getShortcutManager().rehydrateFromRegistry();
}
