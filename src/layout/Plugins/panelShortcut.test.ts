/**
 * Ctrl+Z inside a plugin panel did nothing (2026-10-13 QA): the sandboxed
 * frame keeps its keys. The panel forwards Undo / Redo through the message
 * API; the host runs Edit ▸ Undo / Redo — only while that frame has the
 * focus, so a panel cannot undo on its own.
 */

import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import { BuiltinCommands } from '@core/commands/Command';
import { parseToolPanelMessage } from '@core/nativePlugins/pluginToolPanel';
import { runPanelShortcut } from './panelShortcut';

it('runs Edit > Undo / Redo for the focused panel frame, and nothing for an unfocused one', () => {
  const cs = new CommandSystem({ services: {} as never, getState: () => ({}) });
  const execute = jest.spyOn(cs, 'execute').mockResolvedValue(undefined);
  setCommandSystem(cs);
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);

  expect(runPanelShortcut('undo', frame)).toBe(false);  // the focus is elsewhere
  expect(execute).not.toHaveBeenCalled();

  frame.focus();
  expect(document.activeElement).toBe(frame);
  expect(runPanelShortcut('undo', frame)).toBe(true);
  expect(runPanelShortcut('redo', frame)).toBe(true);
  expect(execute.mock.calls.map((c) => c[0])).toEqual([BuiltinCommands.Undo, BuiltinCommands.Redo]);
  expect(runPanelShortcut('undo', null)).toBe(false);
  frame.remove();
});

it('a tool panel forwards the same shortcuts; an undo COMMAND from it is still refused', () => {
  expect(parseToolPanelMessage({ premation: 1, type: 'shortcut', action: 'redo' })).toEqual({ type: 'shortcut', action: 'redo' });
  expect(parseToolPanelMessage({ premation: 1, type: 'shortcut', action: 'quit' })).toBeNull();
  expect(parseToolPanelMessage({ premation: 1, id: 2, type: 'command', request: { type: 'undo' } })).toMatchObject({ type: 'invalid' });
});
