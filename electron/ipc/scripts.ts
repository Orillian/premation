/**
 * File ▸ Scripts (After Effects' layout): the user Scripts folder, reading a
 * script file the user picked, and saving from the Script Editor panel.
 *
 * The folder is `<userData>/Scripts`, created on demand. The page names
 * scripts IN that folder by file name only (no separators, `.js` / `.jsx`),
 * and reaches any other file only through a native dialog the user answered
 * — main remembers those paths for the session, so Save can write back to a
 * script the user opened from elsewhere, and nothing else. Every write is
 * temp-file + rename (atomicWrite.ts). A script's source crosses to the page
 * as data; it runs in the page's script sandbox (src/core/scripting).
 *
 * Every channel goes through `ipcGuard`'s `handle`, so the sender-frame check
 * applies.
 */

import { mkdirSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { dialog, shell, type OpenDialogOptions, type SaveDialogOptions } from 'electron';
import { handle } from '../ipcGuard';
import { writeFileAtomic } from '../atomicWrite';

export interface ScriptEntryDto {
  /** The file name (`Rename Layers.jsx`). */
  name: string;
  path: string;
}

export interface ScriptFileDto {
  name: string;
  path: string;
  source: string;
  /** In the Scripts folder (saved by name) or a file the user picked elsewhere. */
  inScriptsFolder: boolean;
}

/** A script file is at most this big: a script, not a payload. */
export const MAX_SCRIPT_BYTES = 4 * 1024 * 1024;

const SCRIPT_EXT = /\.(jsx?|jsxinc)$/i;

/** A bare script file name the page may name inside the Scripts folder. */
export function isScriptFileName(name: unknown): name is string {
  return typeof name === 'string'
    && name.length > 0 && name.length <= 200
    && !/[\\/:*?"<>|\0]/.test(name)
    && name !== '.' && name !== '..' && !name.startsWith('.')
    && /\.jsx?$/i.test(name);
}

/** The Scripts folder's runnable entries, sorted as a menu lists them. */
export async function listScripts(dir: string): Promise<ScriptEntryDto[]> {
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name);
  } catch {
    return [];
  }
  return names
    .filter((n) => SCRIPT_EXT.test(n) && !/\.jsxinc$/i.test(n) && !n.startsWith('.'))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))
    .map((name) => ({ name, path: path.join(dir, name) }));
}

export interface ScriptIpcDeps {
  /** `<userData>/Scripts`. */
  dir: () => string;
  openPath?: (p: string) => Promise<string>;
  ensureDir?: (p: string) => void;
  showOpenDialog?: typeof dialog.showOpenDialog;
  showSaveDialog?: typeof dialog.showSaveDialog;
  writeFile?: (p: string, data: string) => Promise<void>;
}

/** The handler bodies, exported for the test. */
export function scriptHandlers(deps: ScriptIpcDeps) {
  const ensure = deps.ensureDir ?? ((p: string) => { mkdirSync(p, { recursive: true }); });
  const openPath = deps.openPath ?? ((p: string) => shell.openPath(p));
  const showOpen = deps.showOpenDialog ?? ((opts: OpenDialogOptions) => dialog.showOpenDialog(opts));
  const showSave = deps.showSaveDialog ?? ((opts: SaveDialogOptions) => dialog.showSaveDialog(opts));
  const write = deps.writeFile ?? ((p: string, data: string) => writeFileAtomic(p, data));
  /** Files outside the folder the user chose in a dialog this session. */
  const granted = new Set<string>();

  const folder = (): string => {
    const dir = deps.dir();
    ensure(dir);
    return dir;
  };
  const inFolder = (p: string): boolean => path.dirname(path.resolve(p)) === path.resolve(deps.dir());

  const readScript = async (p: string): Promise<ScriptFileDto> => {
    const s = await stat(p);
    if (!s.isFile()) throw new Error('Not a file.');
    if (s.size > MAX_SCRIPT_BYTES) throw new Error(`The script is larger than ${MAX_SCRIPT_BYTES / 1024 / 1024} MB.`);
    return { name: path.basename(p), path: p, source: await readFile(p, 'utf8'), inScriptsFolder: inFolder(p) };
  };

  return {
    folderPath: (): string => folder(),
    list: async (): Promise<{ folder: string; scripts: ScriptEntryDto[] }> => {
      const dir = folder();
      return { folder: dir, scripts: await listScripts(dir) };
    },
    openFolder: async (): Promise<{ ok: boolean; path: string; error?: string }> => {
      const dir = deps.dir();
      try {
        ensure(dir);
        const error = await openPath(dir);
        return error ? { ok: false, path: dir, error } : { ok: true, path: dir };
      } catch (err) {
        return { ok: false, path: dir, error: err instanceof Error ? err.message : String(err) };
      }
    },
    /** A script in the Scripts folder, by file name. */
    read: async (name: unknown): Promise<ScriptFileDto | null> => {
      if (!isScriptFileName(name)) return null;
      try {
        return await readScript(path.join(folder(), name));
      } catch {
        return null;
      }
    },
    /** Run Script File… / the editor's Open: a native picker. Null when cancelled. */
    pick: async (): Promise<ScriptFileDto | null> => {
      const res = await showOpen({
        defaultPath: folder(),
        properties: ['openFile'],
        filters: [
          { name: 'Scripts', extensions: ['jsx', 'js'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      const p = res.canceled ? undefined : res.filePaths[0];
      if (!p) return null;
      granted.add(path.resolve(p));
      return readScript(p);
    },
    /**
     * Save: a file name in the Scripts folder, or a path the user picked this
     * session. Anything else is refused (the page cannot write where it likes).
     */
    save: async (req: unknown): Promise<{ ok: boolean; name?: string; path?: string; error?: string }> => {
      const r = (req && typeof req === 'object' ? req : {}) as { name?: unknown; path?: unknown; source?: unknown };
      if (typeof r.source !== 'string' || r.source.length > MAX_SCRIPT_BYTES) return { ok: false, error: 'Nothing to save.' };
      let target: string;
      if (typeof r.path === 'string' && r.path) {
        const abs = path.resolve(r.path);
        if (!granted.has(abs) && !(inFolder(abs) && isScriptFileName(path.basename(abs)))) {
          return { ok: false, error: 'That file was not opened from a dialog; use Save As.' };
        }
        target = abs;
      } else if (isScriptFileName(r.name)) {
        target = path.join(folder(), r.name);
      } else {
        return { ok: false, error: 'A script name ends in .js or .jsx and has no folder in it.' };
      }
      try {
        await write(target, r.source);
        return { ok: true, name: path.basename(target), path: target };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    /** Save As: a native save dialog in the Scripts folder. Null when cancelled. */
    saveAs: async (req: unknown): Promise<{ ok: boolean; name?: string; path?: string; error?: string } | null> => {
      const r = (req && typeof req === 'object' ? req : {}) as { name?: unknown; source?: unknown };
      if (typeof r.source !== 'string' || r.source.length > MAX_SCRIPT_BYTES) return { ok: false, error: 'Nothing to save.' };
      const suggested = isScriptFileName(r.name) ? r.name : 'Untitled.jsx';
      const res = await showSave({
        defaultPath: path.join(folder(), suggested),
        filters: [{ name: 'Scripts', extensions: ['jsx', 'js'] }],
      });
      if (res.canceled || !res.filePath) return null;
      const abs = path.resolve(res.filePath);
      try {
        await write(abs, r.source);
        granted.add(abs);
        return { ok: true, name: path.basename(abs), path: abs };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export function registerScriptIpc(deps: ScriptIpcDeps): void {
  const h = scriptHandlers(deps);
  handle('scripts:folderPath', () => h.folderPath());
  handle('scripts:list', () => h.list());
  handle('scripts:openFolder', () => h.openFolder());
  handle('scripts:read', (_e, name: unknown) => h.read(name));
  handle('scripts:pick', () => h.pick());
  handle('scripts:save', (_e, req: unknown) => h.save(req));
  handle('scripts:saveAs', (_e, req: unknown) => h.saveAs(req));
}
