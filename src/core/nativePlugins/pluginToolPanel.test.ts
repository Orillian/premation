import { MAX_PANEL_SETTINGS, panelMayRunEditorCommand, parseToolPanelMessage } from './pluginToolPanel';

const msg = (m: Record<string, unknown>) => parseToolPanelMessage({ premation: 1, id: 7, ...m });

describe('plugin tool panel: settings and editor commands', () => {
  it('reads and replaces the plugin settings', () => {
    expect(msg({ type: 'settings' })).toEqual({ id: 7, type: 'settings' });
    expect(msg({ type: 'settings', set: { buttons: [{ id: 'a' }] } })).toEqual({ id: 7, type: 'settings', set: { buttons: [{ id: 'a' }] } });
  });

  it('refuses settings that are not an object or too large', () => {
    expect(msg({ type: 'settings', set: [1] })).toMatchObject({ type: 'invalid' });
    expect(msg({ type: 'settings', set: 'x' })).toMatchObject({ type: 'invalid' });
    expect(msg({ type: 'settings', set: { big: 'x'.repeat(MAX_PANEL_SETTINGS) } })).toMatchObject({ type: 'invalid', error: 'the settings are too large' });
  });

  it('lists and runs editor commands, never files, the app or plugin management', () => {
    expect(msg({ type: 'listEditorCommands' })).toEqual({ id: 7, type: 'listEditorCommands' });
    expect(msg({ type: 'editorCommand', command: 'layer.precompose' })).toEqual({ id: 7, type: 'editorCommand', command: 'layer.precompose' });
    for (const id of ['file.save', 'File.Export', 'app.quit', 'help.website', 'plugins.install', 'account.signOut']) {
      expect(panelMayRunEditorCommand(id)).toBe(false);
      expect(msg({ type: 'editorCommand', command: id })).toMatchObject({ type: 'invalid' });
    }
    expect(msg({ type: 'editorCommand', command: '' })).toMatchObject({ type: 'invalid' });
    expect(msg({ type: 'editorCommand' })).toMatchObject({ type: 'invalid' });
  });
});
