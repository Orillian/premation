import type { DropdownItem } from '@components/Dropdown';
import type { IconName } from '@components/Icon';
import { getWorkspaceManager } from '@core/layout/workspaceManager';
import { customPrompt } from '@components/Modal/Dialogs';
import { useUIStore } from '@stores/uiStore';
import { useLayoutStore } from '@stores/layoutStore';
import { t } from '@core/i18n';

export const WORKSPACE_ICONS: Record<string, IconName> = {
  default: 'layout',
  motion: 'play',
  design: 'shape',
  vfx: 'sparkles',
  minimal: 'minimize',
  color: 'palette',
};

/**
 * Builds the workspace and layout preset dropdown items list.
 */
export function buildWorkspaceItems(): DropdownItem[] {
  const manager = getWorkspaceManager();
  const all = manager.listWorkspaces();
  const builtins = all.filter((w) => w.builtin);
  const custom = all.filter((w) => !w.builtin);

  const items: DropdownItem[] = builtins.map((w) => ({
    type: 'item',
    id: `ws-${w.id}`,
    label: w.name,
    icon: WORKSPACE_ICONS[w.id] ?? 'layout',
    onSelect: () => manager.applyWorkspace(w.id),
  }));

  if (custom.length > 0) {
    items.push({ type: 'separator' });
    for (const w of custom) {
      items.push({
        type: 'item',
        id: `ws-${w.id}`,
        label: w.name,
        icon: 'layout',
        submenu: [
          { type: 'item', id: `ws-apply-${w.id}`, label: t('workspace.layoutMenu.apply', 'Apply'), icon: 'check', onSelect: () => manager.applyWorkspace(w.id) },
          { type: 'item', id: `ws-del-${w.id}`, label: t('workspace.layoutMenu.delete', 'Delete'), icon: 'trash', onSelect: () => manager.deleteWorkspace(w.id) },
        ],
      });
    }
  }

  items.push({ type: 'separator' });
  items.push({
    type: 'item',
    id: 'ws-save',
    label: t('workspace.layoutMenu.saveCurrent', 'Save Current Workspace…'),
    icon: 'download',
    onSelect: () => {
      void (async () => {
        const name = await customPrompt(
          t('workspace.layoutMenu.saveTitle', 'Save Workspace'),
          t('workspace.layoutMenu.saveMessage', 'Name this layout. It will appear in this menu and in Customize ▸ Workspaces.'),
          '',
          { placeholder: t('workspace.layoutMenu.savePlaceholder', 'My layout'), confirmLabel: t('workspace.layoutMenu.save', 'Save') },
        );
        if (!name?.trim()) return;
        getWorkspaceManager().saveCurrentWorkspace(name.trim());
        useUIStore.getState().notify({ level: 'success', message: t('workspace.layoutMenu.saved', 'Saved workspace “{name}”', { name: name.trim() }), durationMs: 2600 });
      })();
    },
  });
  items.push({
    type: 'item',
    id: 'ws-reset',
    label: t('workspace.layoutMenu.reset', 'Reset Layout to Default'),
    icon: 'undo',
    onSelect: () => useLayoutStore.getState().resetLayout(),
  });
  return items;
}
