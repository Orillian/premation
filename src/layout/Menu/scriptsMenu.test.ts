/**
 * File ▸ Scripts: the fixed commands, then the Scripts folder's scripts (run
 * on click, with the permissions an AE script needs), and the File menu
 * carries the submenu with the commands Providers builds.
 */

const runScript = jest.fn(async () => ({ ok: true, value: null, outcome: 'engine', logs: [] }));
jest.mock('@core/scripting/scriptHost', () => ({ runScript, setScriptConsentPrompt: jest.fn() }));

import { APP_MENU, type MenuItemModel } from './menuModel';
import { buildScriptsMenuItems } from './scriptsMenu';
import { refreshScriptList, permissionsFor, scriptDisplayName } from '@layout/Scripts/userScripts';
import { useScriptsStore } from '@stores/scriptsStore';
import { readSource } from '@/__testHelpers__/readSource';

type Api = { scripts: Record<string, jest.Mock> };

function installApi(scripts: Array<{ name: string; path: string }>): Api {
  const api: Api = {
    scripts: {
      list: jest.fn(async () => ({ folder: '/u/Scripts', scripts })),
      read: jest.fn(async (name: string) => ({ name, path: `/u/Scripts/${name}`, source: 'app.project.numItems;', inScriptsFolder: true })),
      pick: jest.fn(),
      openFolder: jest.fn(),
      save: jest.fn(),
      saveAs: jest.fn(),
    },
  };
  (window as unknown as { motionEditor?: unknown }).motionEditor = api;
  return api;
}

const FIXED: MenuItemModel[] = [{ commandId: 'file.runScriptFile', label: 'Run Script File…' }];

afterEach(() => {
  delete (window as unknown as { motionEditor?: unknown }).motionEditor;
  runScript.mockClear();
});

describe('File ▸ Scripts', () => {
  it('is a File submenu whose fixed entries are commands Providers builds', () => {
    const file = APP_MENU.find((g) => g.id === 'file')!;
    const scripts = file.items.find((i) => i.label === 'Scripts')!;
    expect(scripts.labelKey).toBe('menu.sub.scripts');
    const kids = typeof scripts.children === 'function' ? scripts.children() : scripts.children ?? [];
    const ids = kids.map((k) => k.commandId).filter(Boolean);
    expect(ids).toEqual(['file.runScriptFile', 'view.scriptEditor', 'file.openScriptsFolder']);
    expect(readSource('providers/Providers.tsx')).toContain('buildScriptCommands()');
    const commands = readSource('layout/Scripts/scriptCommands.ts');
    for (const id of ids) expect(commands).toContain(`'${String(id)}'`);
  });

  it('without the desktop app lists only the fixed entries', () => {
    expect(buildScriptsMenuItems(FIXED)).toEqual(FIXED);
  });

  it('lists the folder after a rescan, by name without the extension', async () => {
    installApi([{ name: 'Rename Layers.jsx', path: '/u/Scripts/Rename Layers.jsx' }, { name: 'tool.js', path: '/u/Scripts/tool.js' }]);
    await refreshScriptList();
    const items = buildScriptsMenuItems(FIXED);
    expect(items.map((i) => (i.separator ? '—' : i.label))).toEqual(['Run Script File…', '—', 'Rename Layers', 'tool']);
  });

  it('says so when the folder is empty', async () => {
    installApi([]);
    useScriptsStore.getState().setListing('/u/Scripts', []);
    await refreshScriptList();
    const items = buildScriptsMenuItems(FIXED);
    expect(items[items.length - 1]).toEqual({ label: 'No scripts in the Scripts folder' });
  });

  it('a click runs the script with read + write (an AE script has no header)', async () => {
    const api = installApi([{ name: 'Go.jsx', path: '/u/Scripts/Go.jsx' }]);
    await refreshScriptList();
    const entry = buildScriptsMenuItems(FIXED).find((i) => i.label === 'Go')!;
    entry.onSelect!();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(api.scripts.read).toHaveBeenCalledWith('Go.jsx');
    expect(runScript).toHaveBeenCalledWith('app.project.numItems;', expect.objectContaining({
      name: 'Go',
      permissions: ['document.read', 'document.write'],
    }));
  });

  it('a declared header is asked for exactly', () => {
    expect(permissionsFor('// @permissions document.read\nreturn 1;')).toEqual(['document.read']);
    expect(permissionsFor('alert(1)')).toEqual(['document.read', 'document.write']);
    expect(scriptDisplayName('A.b.jsx')).toBe('A.b');
  });
});
