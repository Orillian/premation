/**
 * After Effects commands the engine already carried with no way to reach
 * them from the editor (tier 2 of the AE comparison, 2026-10-29):
 *
 *   Composition ▸ Trim Comp to Work Area   (Ctrl+Shift+X)  `trimCompToWorkArea`
 *   Composition ▸ Crop Comp to Region of Interest          `cropComposition`
 *   File ▸ Dependencies ▸ Remove Unused Footage            `removeUnusedItems`
 *   Edit ▸ Copy with Property Links        (Ctrl+Alt+C)    clipboardEdits.ts
 *
 * Each is ONE engine entry (undoable) and says what it did.
 */

import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import { edit } from '@core/engine/uiEdits';
import { settingsSetWorkArea } from '@core/mirror/compFacts';
import { activeCompIdNow } from '@hooks/useMirror';
import { activeCompSettingsNow } from '@hooks/useMirrorFrame';
import { documentMirror } from '@stores/documentMirror';
import { useGuidesStore } from '@stores/guidesStore';
import { useUIStore } from '@stores/uiStore';
import { t } from '@core/i18n';
import { canCopyWithPropertyLinks, copyWithPropertyLinksEdit } from '../clipboardEdits';

const notify = (message: string, level: 'info' | 'success' | 'warning' = 'success'): void => {
  useUIStore.getState().notify({ level, message, durationMs: 3600 });
};

/** The work area, when one is set narrower than the composition. */
function workAreaNow(): { start: number; end: number } | null {
  return settingsSetWorkArea(activeCompSettingsNow());
}

/** A region of interest worth cropping to: set, non-empty, inside the frame. */
export function cropRegion(
  roi: { x: number; y: number; width: number; height: number } | null,
  frame: { width: number; height: number } | undefined,
): { x: number; y: number; width: number; height: number } | null {
  if (!roi || !frame) return null;
  const x0 = Math.max(0, Math.round(roi.x));
  const y0 = Math.max(0, Math.round(roi.y));
  const x1 = Math.min(frame.width, Math.round(roi.x + roi.width));
  const y1 = Math.min(frame.height, Math.round(roi.y + roi.height));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  if (x0 === 0 && y0 === 0 && x1 === frame.width && y1 === frame.height) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function cropRegionNow(): { x: number; y: number; width: number; height: number } | null {
  const s = activeCompSettingsNow();
  return cropRegion(useGuidesStore.getState().roi, s ? { width: s.width, height: s.height } : undefined);
}

/** Footage items no layer, effect, light or keyed value names (the engine decides; this only enables the row). */
function hasFootage(): boolean {
  for (const item of documentMirror().items.values()) if (item.kind === 'footage') return true;
  return false;
}

export function buildCompUtilityCommands(): ReadonlyArray<Command> {
  return [
    {
      id: asCommandId('comp.trimToWorkArea'),
      label: 'Trim Comp to Work Area',
      description: 'Shorten the composition to its work area (layers keep their timing)',
      shortcut: { key: 'x', meta: true, shift: true },
      enabled: () => !!activeCompIdNow() && workAreaNow() !== null,
      execute: async () => {
        const comp = activeCompIdNow();
        if (!comp || !workAreaNow()) return;
        const res = await edit(t('commands.comp.trimToWorkArea', 'Trim Comp to Work Area'), { type: 'trimCompToWorkArea', comp });
        if (res.ok) notify(t('commands.comp.trimmed', 'Composition trimmed to its work area.'));
      },
    },
    {
      id: asCommandId('comp.cropToRoi'),
      label: 'Crop Comp to Region of Interest',
      description: 'Resize the composition to the region of interest; layers stay where they are on screen',
      enabled: () => !!activeCompIdNow() && cropRegionNow() !== null,
      execute: async () => {
        const comp = activeCompIdNow();
        const region = cropRegionNow();
        if (!comp || !region) return;
        const res = await edit(t('commands.comp.cropToRoi', 'Crop Comp to Region of Interest'), { type: 'cropComposition', comp, region });
        if (res.ok) {
          // The region was the old frame's; it means nothing in the new one.
          useGuidesStore.getState().setRoi(null);
          notify(t('commands.comp.cropped', 'Composition cropped to {w} × {h}.', { w: region.width, h: region.height }));
        }
      },
    },
    {
      id: asCommandId('file.removeUnusedFootage'),
      label: 'Remove Unused Footage',
      description: 'Remove footage nothing in the project uses (one undo step)',
      enabled: hasFootage,
      execute: async () => {
        const res = await edit(t('commands.file.removeUnused', 'Remove Unused Footage'), { type: 'removeUnusedItems' });
        if (!res.ok) return;
        const result = res.value[0];
        const removed = result?.type === 'removeUnusedItems' ? result.items.length : 0;
        notify(removed === 0
          ? t('commands.file.removeUnusedNone', 'Every footage item is in use.')
          : t('commands.file.removeUnusedDone', 'Removed {n} unused footage item(s).', { n: removed }),
        removed === 0 ? 'info' : 'success');
      },
    },
    {
      id: asCommandId('edit.copyWithPropertyLinks'),
      label: 'Copy with Property Links',
      description: 'Copy the selected layers or properties; pasting links them to the originals',
      shortcut: { key: 'c', meta: true, alt: true },
      enabled: canCopyWithPropertyLinks,
      execute: async () => {
        const kind = await copyWithPropertyLinksEdit();
        if (kind) notify(t('commands.edit.copiedWithLinks', 'Copied with property links — paste to link.'), 'info');
      },
    },
  ];
}
