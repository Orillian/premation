/**
 * Edit ▸ Edit Original (AE: Ctrl+E / Cmd+E) — open the selected footage's
 * source file in the OS default application for its type, then reload it
 * when it is saved there (`footageWatchSync.ts`).
 *
 * Acts on the selected layers' footage, or on the Assets panel's selection
 * when that panel has focus (`editOriginalTargets`). Solids, text, shapes,
 * cameras, lights, nulls and precomps have no file: the command is disabled.
 * A missing (offline) file says so instead of failing silently.
 *
 * Desktop only: the browser build has no OS application to hand a file to,
 * so the command stays disabled there.
 */

import { documentMirror, hasDocumentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { panelAssetSelectionIds } from '@core/composition/assetSelection';
import { t } from '@core/i18n';
import { editOriginalTargets, isEditableOriginal, MAX_EDIT_ORIGINAL_FILES, type EditableItem } from './editOriginalLogic';
import { noteEditedOriginal } from './footageWatchSync';
import { formatChord, isMacKeyboard } from '@core/commands/formatChord';
import { getShortcutOverrides, resolveChord } from '@core/commands/shortcutOverrides';
import type { KeyChord } from '@app-types/common';

/** The command id (Providers registers it) and AE's default chord, Ctrl+E / Cmd+E. */
export const EDIT_ORIGINAL_COMMAND = 'edit.editOriginal';
export const EDIT_ORIGINAL_CHORD: KeyChord = { key: 'e', meta: true };

/** The chord as the context menus print it (Ctrl+E / ⌘E), honouring a user rebind or disable. */
export function editOriginalShortcutLabel(): string | undefined {
  const chord = resolveChord(EDIT_ORIGINAL_COMMAND, EDIT_ORIGINAL_CHORD, getShortcutOverrides());
  if (!chord) return undefined;
  // `meta` is the platform's command key: Ctrl off the Mac (resolveChord maps it at runtime).
  return formatChord(chord.meta && !isMacKeyboard() ? { ...chord, meta: false, ctrl: true } : chord);
}

/** Whether this build can hand a file to the OS at all. */
export function canOpenOriginals(): boolean {
  return typeof window !== 'undefined' && typeof window.motionEditor?.shell?.openFile === 'function';
}

/** Does the Assets panel's list have keyboard focus? */
function assetsPanelFocused(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.activeElement;
  return !!el && typeof el.closest === 'function' && el.closest('[data-tour="assets-panel"]') !== null;
}

/** The footage items Edit Original would open now. */
export function currentEditOriginalTargets(): EditableItem[] {
  if (!hasDocumentMirror()) return [];
  const m = documentMirror();
  return editOriginalTargets({
    layerIds: useSelectionStore.getState().ids,
    panelIds: panelAssetSelectionIds(),
    panelFocused: assetsPanelFocused(),
    layerSource: (id) => m.layer(id)?.source,
    item: (id) => m.item(id),
  });
}

/** The command's enabled state: desktop build, and at least one selected item with a file. */
export function canEditOriginal(): boolean {
  return canOpenOriginals() && currentEditOriginalTargets().length > 0;
}

function notify(level: 'info' | 'warning' | 'error', message: string): void {
  useUIStore.getState().notify({ level, message, durationMs: level === 'info' ? 3000 : 6000 });
}

/**
 * Open each item's file (at most MAX_EDIT_ORIGINAL_FILES) and start watching
 * it for the save that comes back. Resolves to the number of files opened.
 */
export async function editOriginalItems(items: ReadonlyArray<EditableItem | undefined>): Promise<number> {
  const open = window.motionEditor?.shell?.openFile;
  if (!open) {
    notify('info', t('assets.editOriginal.unavailable', 'Edit Original needs the desktop app.'));
    return 0;
  }
  const targets = items.filter((i): i is EditableItem => isEditableOriginal(i));
  if (targets.length === 0) {
    notify('info', t('assets.editOriginal.noFile', 'Select a footage layer or item that has a file on disk.'));
    return 0;
  }
  if (targets.length > MAX_EDIT_ORIGINAL_FILES) {
    notify('warning', t('assets.editOriginal.tooMany', 'Opening the first {n} of {total} files.', { n: MAX_EDIT_ORIGINAL_FILES, total: targets.length }));
  }
  let opened = 0;
  for (const item of targets.slice(0, MAX_EDIT_ORIGINAL_FILES)) {
    let res: Awaited<ReturnType<NonNullable<typeof open>>>;
    try {
      res = await open(item.path);
    } catch (e) {
      res = { ok: false, reason: 'failed', path: item.path, error: e instanceof Error ? e.message : String(e) };
    }
    if (res.ok) {
      opened += 1;
      // Its folder is watched first from now on: the save comes back as a reload.
      noteEditedOriginal(item.path);
      continue;
    }
    if (res.reason === 'missing') {
      notify('warning', t('assets.editOriginal.missing', 'The file for “{name}” is missing: {path}', { name: item.name, path: res.path || item.path }));
    } else if (res.reason === 'refused') {
      notify('error', t('assets.editOriginal.refused', '“{name}” is not a media file Edit Original will open.', { name: item.name }));
    } else {
      notify('error', t('assets.editOriginal.failed', 'Could not open “{name}”: {error}', { name: item.name, error: res.error ?? '' }));
    }
  }
  return opened;
}

/** Edit ▸ Edit Original on the current selection. */
export function runEditOriginal(): Promise<number> {
  return editOriginalItems(currentEditOriginalTargets());
}

/** Edit Original on one footage item by id (the timeline's and Assets panel's context menus). */
export function editOriginalItem(itemId: string): Promise<number> {
  const item = hasDocumentMirror() ? documentMirror().item(itemId) : undefined;
  return editOriginalItems(item ? [item] : []);
}
