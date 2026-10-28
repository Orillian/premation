/**
 * What a plugin panel may do beyond the engine API (core/nativePlugins/pluginToolPanel.ts):
 * keep its own settings, and run editor commands the way their menu items do — so a
 * toolbar panel can put any Premation command on a button.
 *
 *   • Settings live in the editor prefs (`pluginPanelSettings`, per plugin id): per user and
 *     installation, never in the project document (CLAUDE.md: editor state stays out of it).
 *   • An editor command runs only while that panel's frame holds the focus, as the undo
 *     shortcut does (panelShortcut.ts): the click that asked for it happened in the panel, so
 *     a panel cannot run commands on its own. Files, the app, the account, help and plugin
 *     management are never available (panelMayRunEditorCommand).
 */

import type { CommandId } from '@app-types/common';
import { getCommandRegistry } from '@core/commands/Command';
import { commandLabel } from '@core/commands/commandLabel';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { ensureCommandsRegistered } from '@core/commands/ensureCommandsRegistered';
import { formatChord } from '@core/commands/formatChord';
import { getShortcutOverrides, resolveChord } from '@core/commands/shortcutOverrides';
import { panelMayRunEditorCommand } from '@core/nativePlugins/pluginToolPanel';
import { readPersisted, writePersisted } from '@core/settings/persistedValue';

const SETTINGS_KEY = 'pluginPanelSettings';

type AllSettings = Record<string, Record<string, unknown>>;

/** The plugin's saved settings; `set` replaces them first. */
export function pluginPanelSettings(plugin: string, set?: Record<string, unknown>): Record<string, unknown> {
  const all = readPersisted<AllSettings>(SETTINGS_KEY, {});
  if (set === undefined) return all[plugin] ?? {};
  writePersisted<AllSettings>(SETTINGS_KEY, { ...all, [plugin]: set });
  return set;
}

export interface PanelEditorCommand {
  id: string;
  label: string;
  /** The chord as the menus print it ('' = none). */
  shortcut: string;
  enabled: boolean;
}

export function panelEditorCommands(): PanelEditorCommand[] {
  ensureCommandsRegistered();
  const overrides = getShortcutOverrides();
  const out: PanelEditorCommand[] = [];
  for (const c of getCommandRegistry().all()) {
    const id = c.id as unknown as string;
    if (!c.label || !panelMayRunEditorCommand(id)) continue;
    const chord = resolveChord(id, c.shortcut, overrides);
    let enabled = true;
    try {
      enabled = c.enabled ? c.enabled() : true;
    } catch {
      enabled = false;
    }
    out.push({ id, label: commandLabel(c), shortcut: chord ? formatChord(chord) : '', enabled });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** Run `id` for the panel in `frame`. Throws with the reason it did not run. */
export async function runPanelEditorCommand(id: string, frame: HTMLIFrameElement | null): Promise<void> {
  if (!frame || frame.ownerDocument.activeElement !== frame) throw new Error('click in the panel to run a command');
  if (!panelMayRunEditorCommand(id)) throw new Error(`a panel may not run '${id}'`);
  ensureCommandsRegistered();
  const cmd = getCommandRegistry().get(id as CommandId);
  if (!cmd) throw new Error(`no command '${id}'`);
  if (cmd.enabled && !cmd.enabled()) throw new Error(`'${commandLabel(cmd)}' is not available now`);
  await getCommandSystem().execute(id as CommandId);
}
