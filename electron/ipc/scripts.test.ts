/**
 * File ▸ Scripts IPC: the folder is created on demand and listed as a menu
 * lists it; the page names scripts in it by file name only, and can write
 * nowhere but there and to files the user picked in a dialog.
 */

const handled = new Map<string, (...args: unknown[]) => unknown>();

jest.mock('electron', () => ({ shell: { openPath: jest.fn(async () => '') }, dialog: {} }));
jest.mock('../ipcGuard', () => ({
  handle: (channel: string, fn: (...args: unknown[]) => unknown) => handled.set(channel, fn),
}));

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { isScriptFileName, listScripts, registerScriptIpc, scriptHandlers } from './scripts';

let root: string;
let dir: string;
beforeEach(() => {
  handled.clear();
  root = mkdtempSync(path.join(tmpdir(), 'premation-scripts-'));
  dir = path.join(root, 'Scripts');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const plainWrite = async (p: string, data: string): Promise<void> => { writeFileSync(p, data); };

describe('scripts IPC', () => {
  it('registers every channel through the guarded handle', () => {
    registerScriptIpc({ dir: () => dir });
    expect([...handled.keys()].sort()).toEqual([
      'scripts:folderPath', 'scripts:list', 'scripts:openFolder', 'scripts:pick', 'scripts:read', 'scripts:save', 'scripts:saveAs',
    ]);
  });

  it('creates the folder on demand and lists .js / .jsx scripts, sorted', async () => {
    const h = scriptHandlers({ dir: () => dir, writeFile: plainWrite });
    expect(await h.list()).toEqual({ folder: dir, scripts: [] });
    expect(existsSync(dir)).toBe(true);
    for (const n of ['b.jsx', 'A Script.js', 'notes.txt', '.hidden.jsx', 'lib.jsxinc', 'Script 10.jsx', 'Script 9.jsx']) writeFileSync(path.join(dir, n), '//');
    mkdirSync(path.join(dir, 'ScriptUI Panels'));
    expect((await listScripts(dir)).map((s) => s.name)).toEqual(['A Script.js', 'b.jsx', 'Script 9.jsx', 'Script 10.jsx']);
  });

  it('reads a script by bare name only', async () => {
    const h = scriptHandlers({ dir: () => dir, writeFile: plainWrite });
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'Hello.jsx'), 'alert(1);');
    writeFileSync(path.join(root, 'secret.jsx'), 'nope');
    expect(await h.read('Hello.jsx')).toMatchObject({ name: 'Hello.jsx', source: 'alert(1);', inScriptsFolder: true });
    expect(await h.read('../secret.jsx')).toBeNull();
    expect(await h.read(path.join(root, 'secret.jsx'))).toBeNull();
    expect(await h.read('Missing.jsx')).toBeNull();
  });

  it('saves by name into the folder, and refuses any other path the user did not pick', async () => {
    const h = scriptHandlers({ dir: () => dir, writeFile: plainWrite });
    expect(await h.save({ name: 'New.jsx', source: 'var a;' })).toMatchObject({ ok: true, name: 'New.jsx' });
    expect(readFileSync(path.join(dir, 'New.jsx'), 'utf8')).toBe('var a;');
    expect(await h.save({ name: '../Escape.jsx', source: 'x' })).toMatchObject({ ok: false });
    expect(await h.save({ name: 'evil.exe', source: 'x' })).toMatchObject({ ok: false });
    expect(await h.save({ path: path.join(root, 'elsewhere.jsx'), source: 'x' })).toMatchObject({ ok: false });
    expect(existsSync(path.join(root, 'elsewhere.jsx'))).toBe(false);
  });

  it('writes back to a file the user picked in the dialog', async () => {
    const picked = path.join(root, 'picked.jsx');
    writeFileSync(picked, 'old');
    const h = scriptHandlers({
      dir: () => dir,
      writeFile: plainWrite,
      showOpenDialog: (async () => ({ canceled: false, filePaths: [picked] })) as never,
    });
    expect(await h.pick()).toMatchObject({ name: 'picked.jsx', source: 'old', inScriptsFolder: false });
    expect(await h.save({ path: picked, source: 'new' })).toMatchObject({ ok: true });
    expect(readFileSync(picked, 'utf8')).toBe('new');
  });

  it('a cancelled dialog is null', async () => {
    const h = scriptHandlers({
      dir: () => dir,
      showOpenDialog: (async () => ({ canceled: true, filePaths: [] })) as never,
      showSaveDialog: (async () => ({ canceled: true })) as never,
    });
    expect(await h.pick()).toBeNull();
    expect(await h.saveAs({ name: 'x.jsx', source: '' })).toBeNull();
  });

  it('names a script file strictly', () => {
    expect(isScriptFileName('Rename Layers.jsx')).toBe(true);
    expect(isScriptFileName('tool.js')).toBe(true);
    for (const bad of ['', 'a/b.jsx', 'a\\b.jsx', '..', '.jsx', 'x.txt', 'C:x.jsx', 42]) expect(isScriptFileName(bad)).toBe(false);
  });
});
