/**
 * File ▸ Scripts — After Effects' submenu: the fixed commands (Run Script
 * File…, Open Script Editor, Open Scripts Folder), then every script in the
 * user Scripts folder, which runs on click.
 *
 * Built per draw (a thunk in menuModel), like Window ▸ Workspace: the scripts
 * are user data. Drawing it asks for a rescan (`refreshScriptList`); a changed
 * listing bumps `scriptsStore.revision`, which re-memoises the menu groups
 * (useAppMenuGroups) so the in-app and native menus follow. Script names are
 * file names and never translated (menuI18n.ts); the fixed entries carry
 * their keys from menuModel, the empty-folder caption its own t() call.
 */

import { t } from '@core/i18n';
import { useScriptsStore } from '@stores/scriptsStore';
import { refreshScriptList, runScriptFromFolder, scriptDisplayName, scriptsFolderAvailable } from '@layout/Scripts/userScripts';
import type { MenuItemModel } from './menuModel';

export function buildScriptsMenuItems(fixed: ReadonlyArray<MenuItemModel>): MenuItemModel[] {
  const items: MenuItemModel[] = [...fixed];
  if (typeof window === 'undefined' || !scriptsFolderAvailable()) return items;
  void refreshScriptList();
  const scripts = useScriptsStore.getState().scripts;
  items.push({ separator: true });
  if (scripts.length === 0) {
    items.push({ label: t('scripts.menu.none', 'No scripts in the Scripts folder') });
    return items;
  }
  for (const s of scripts) {
    items.push({ label: scriptDisplayName(s.name), onSelect: () => { void runScriptFromFolder(s.name); } });
  }
  return items;
}
