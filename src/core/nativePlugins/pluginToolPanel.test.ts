import { MAX_PANEL_SETTINGS, MAX_PANEL_TEXT, panelMayRunEditorCommand, parseToolPanelMessage, toolPanelContext } from './pluginToolPanel';

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

  it('runs scripts with a name, refuses empty or huge ones', () => {
    expect(msg({ type: 'runScript', source: 'app.project', name: 'Rename' })).toEqual({ id: 7, type: 'runScript', source: 'app.project', name: 'Rename' });
    expect(msg({ type: 'runScript', source: 'x' })).toMatchObject({ name: 'Panel script' });
    expect(msg({ type: 'runScript', source: '  ' })).toMatchObject({ type: 'invalid' });
    expect(msg({ type: 'runScript', source: 'x'.repeat(MAX_PANEL_TEXT + 1) })).toMatchObject({ type: 'invalid' });
  });

  it('binds shortcuts only with a modifier (or an F key)', () => {
    expect(msg({ type: 'setShortcuts', shortcuts: [{ id: 'a', key: 'w', alt: true, shift: true }] })).toEqual({
      id: 7,
      type: 'setShortcuts',
      shortcuts: [{ id: 'a', key: 'w', ctrl: false, alt: true, shift: true, meta: false }],
    });
    expect(msg({ type: 'setShortcuts', shortcuts: [{ id: 'f', key: 'F7' }] })).toMatchObject({ type: 'setShortcuts' });
    expect(msg({ type: 'setShortcuts', shortcuts: [{ id: 'b', key: 'w', shift: true }] })).toMatchObject({ type: 'invalid' });
    expect(msg({ type: 'setShortcuts', shortcuts: 'x' })).toMatchObject({ type: 'invalid' });
  });

  it('saves files under a plain name and opens with an accept filter', () => {
    expect(msg({ type: 'saveFile', name: '../a:b.json', text: '{}' })).toEqual({ id: 7, type: 'saveFile', name: '.._a_b.json', text: '{}' });
    expect(msg({ type: 'saveFile', name: '', text: '{}' })).toMatchObject({ type: 'invalid' });
    expect(msg({ type: 'openFile', accept: '.json' })).toEqual({ id: 7, type: 'openFile', accept: '.json' });
  });

  it('context carries the selected keyframes and properties', () => {
    const c = toolPanelContext({ plugin: 'p', comp: 'c', layers: ['l'], time: 0, keyframes: [{ layer: 'l', key: 'k', path: 'transform/position' }], properties: [{ layer: 'l', path: 'transform/opacity', member: 0 }] });
    expect(c).toMatchObject({ keyframes: [{ key: 'k' }], properties: [{ path: 'transform/opacity' }] });
    expect(toolPanelContext({ plugin: 'p', comp: 'c', layers: [], time: 0 })).toMatchObject({ keyframes: [], properties: [] });
  });
});
