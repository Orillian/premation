/**
 * File ▸ Scripts and the Script Editor panel — editor state, never document
 * state (CLAUDE.md: editor state stays out of the project):
 *
 *   - the user Scripts folder's listing (what File ▸ Scripts lists), refreshed
 *     when the menu is drawn, when the window regains focus and after a save;
 *     `revision` bumps only when the list really changed, so the menu memo
 *     (useAppMenuGroups) and the native menu are re-sent once per change;
 *   - the Script Editor's buffer (source, file name, where it was opened
 *     from) and its console, kept here so closing or undocking the panel
 *     keeps them, and so a run from the menu writes to the same console.
 */

import { create } from 'zustand';

export interface ScriptListEntry { name: string; path: string }

export type ScriptConsoleKind = 'log' | 'warn' | 'error' | 'result' | 'info';

export interface ScriptConsoleLine {
  id: number;
  kind: ScriptConsoleKind;
  text: string;
}

/** The console keeps the last lines only: it is a run log, not an archive. */
export const SCRIPT_CONSOLE_LIMIT = 500;

export const DEFAULT_SCRIPT_SOURCE = [
  '// After Effects-style scripting: app.project, comps, layers, properties.',
  '// One run is one undo entry; Ctrl+Enter runs. See docs/SCRIPTING.md.',
  'var comp = app.project.activeItem;',
  'if (!(comp instanceof CompItem)) throw new Error("Open a composition first.");',
  '$.writeln(comp.name + ": " + comp.numLayers + " layers");',
  '',
].join('\n');

interface ScriptsState {
  folder: string | null;
  scripts: ScriptListEntry[];
  /** Bumps when `scripts` changes. */
  revision: number;
  setListing(folder: string, scripts: ScriptListEntry[]): void;

  /** The editor buffer. */
  source: string;
  /** The file name shown in the panel (`Untitled.jsx` until saved). */
  fileName: string;
  /** Where Save writes: a Scripts-folder file by name, or a path the user picked. */
  filePath: string | null;
  inScriptsFolder: boolean;
  dirty: boolean;
  setSource(source: string): void;
  loadFile(f: { name: string; path: string; source: string; inScriptsFolder: boolean }): void;
  markSaved(f: { name: string; path: string; inScriptsFolder: boolean }): void;
  newFile(): void;

  running: boolean;
  setRunning(on: boolean): void;
  console: ScriptConsoleLine[];
  print(kind: ScriptConsoleKind, text: string): void;
  clearConsole(): void;
}

let lineSeq = 0;

const sameList = (a: readonly ScriptListEntry[], b: readonly ScriptListEntry[]): boolean =>
  a.length === b.length && a.every((x, i) => x.name === b[i]!.name && x.path === b[i]!.path);

export const useScriptsStore = create<ScriptsState>((set, get) => ({
  folder: null,
  scripts: [],
  revision: 0,
  setListing: (folder, scripts) => {
    const s = get();
    if (s.folder === folder && sameList(s.scripts, scripts)) return;
    set({ folder, scripts, revision: s.revision + 1 });
  },

  source: DEFAULT_SCRIPT_SOURCE,
  fileName: 'Untitled.jsx',
  filePath: null,
  inScriptsFolder: false,
  dirty: false,
  setSource: (source) => set({ source, dirty: true }),
  loadFile: (f) => set({ source: f.source, fileName: f.name, filePath: f.path, inScriptsFolder: f.inScriptsFolder, dirty: false }),
  markSaved: (f) => set({ fileName: f.name, filePath: f.path, inScriptsFolder: f.inScriptsFolder, dirty: false }),
  newFile: () => set({ source: DEFAULT_SCRIPT_SOURCE, fileName: 'Untitled.jsx', filePath: null, inScriptsFolder: false, dirty: false }),

  running: false,
  setRunning: (running) => set({ running }),
  console: [],
  print: (kind, text) => {
    lineSeq += 1;
    const next = [...get().console, { id: lineSeq, kind, text }];
    set({ console: next.length > SCRIPT_CONSOLE_LIMIT ? next.slice(next.length - SCRIPT_CONSOLE_LIMIT) : next });
  },
  clearConsole: () => set({ console: [] }),
}));
