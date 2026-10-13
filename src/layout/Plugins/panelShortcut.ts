/**
 * A plugin panel's frame is sandboxed (scripts only, an opaque origin): a key
 * pressed inside it never reaches the editor's shortcuts, so Ctrl+Z there did
 * nothing (2026-10-13 QA). The panel forwards the editor shortcuts through the
 * message API (`{ type: 'shortcut', action }`, docs/PLUGIN_SDK.md "Plugin
 * panels") and the host runs them as the menu would — only while that frame
 * has the focus, so a panel cannot undo the user's work on its own: the key
 * press that sent it happened in the frame.
 */

import type { CommandId } from '@app-types/common';
import { BuiltinCommands } from '@core/commands/Command';
import { getCommandSystem } from '@core/commands/CommandSystem';
import type { PanelShortcut } from '@core/nativePlugins/pluginPanel';

const COMMAND: Record<PanelShortcut, CommandId> = { undo: BuiltinCommands.Undo, redo: BuiltinCommands.Redo };

/**
 * Run Edit ▸ Undo / Redo for the panel in `frame`. Ignored unless that frame holds the focus.
 * Never throws (no command system: nothing happens). Answers whether it ran.
 */
export function runPanelShortcut(action: PanelShortcut, frame: HTMLIFrameElement | null): boolean {
  if (!frame || frame.ownerDocument.activeElement !== frame) return false;
  try {
    void getCommandSystem().execute(COMMAND[action]).catch(() => undefined);
    return true;
  } catch {
    return false;  // no command system in this window
  }
}
