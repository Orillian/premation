/**
 * File ▸ Scripts — running a user script from the editor, and the Scripts
 * folder (electron/ipc/scripts.ts). The run itself is the core sandbox
 * (core/scripting/scriptHost.ts): consent, one undo entry, rollback on error.
 *
 * PERMISSIONS. A script that declares `// @permissions …` asks for exactly
 * that. One that does not — every After Effects script — asks for read AND
 * write, since that is what an AE script does; the consent dialog shows the
 * user what it asks for before anything runs.
 */

import { secondsToFlicks } from '@motion/engine-api';
// The sandbox host loads on the first run: File ▸ Scripts is in the menu model,
// which every menu renderer imports, and the host pulls in the engine session.
import type { ScriptRunResult } from '@core/scripting/scriptHost';
import { declaredPermissions, hasPermissionsHeader, SCRIPT_PERMISSIONS, type ScriptPermission } from '@core/scripting/protocol';
import { activeCompIdNow } from '@hooks/useMirror';
import { t } from '@core/i18n';
import { getTime } from '@stores/playbackClockStore';
import { useScriptsStore } from '@stores/scriptsStore';
import { useUIStore } from '@stores/uiStore';
import { useLayoutStore } from '@stores/layoutStore';
import type { MotionEditorApi } from '@app-types/motionEditor';

export const SCRIPT_EDITOR_PANEL = 'scriptEditor';

type ScriptsApi = NonNullable<MotionEditorApi['scripts']>;

function api(): ScriptsApi | null {
  const w = window as unknown as { motionEditor?: MotionEditorApi; electronAPI?: MotionEditorApi };
  return (w.motionEditor ?? w.electronAPI)?.scripts ?? null;
}

/** The desktop app has a Scripts folder; the browser build does not. */
export function scriptsFolderAvailable(): boolean {
  return typeof window !== 'undefined' && api()?.list !== undefined;
}

/** `Rename Layers.jsx` → `Rename Layers` (the undo entry's and the dialog's name). */
export function scriptDisplayName(fileName: string): string {
  return fileName.replace(/\.(jsx|js)$/i, '') || fileName;
}

/** What a run from the editor asks for (see the module note). */
export function permissionsFor(source: string): ScriptPermission[] {
  return hasPermissionsHeader(source) ? declaredPermissions(source) : [...SCRIPT_PERMISSIONS];
}

let inFlight = false;

/**
 * Run `source` as the user script `name`. Logs, the result and the error go to
 * the Script Editor's console (`scriptsStore`); a run from the menu also
 * toasts. Never throws.
 */
export async function runUserScript(source: string, name: string, opts: { toast?: boolean } = {}): Promise<ScriptRunResult | null> {
  const store = useScriptsStore.getState();
  if (inFlight) {
    useUIStore.getState().notify({ level: 'info', message: t('scripts.run.busy', 'A script is already running.'), durationMs: 4000 });
    return null;
  }
  inFlight = true;
  store.setRunning(true);
  const display = scriptDisplayName(name);
  store.print('info', t('scripts.run.started', 'Running {name}…', { name: display }));
  try {
    const { runScript } = await import('@core/scripting/scriptHost');
    const result = await runScript(source, {
      name: display,
      permissions: permissionsFor(source),
      context: { activeItem: activeCompIdNow() ?? null, time: secondsToFlicks(getTime()) },
      onLog: (level, text) => useScriptsStore.getState().print(level, text),
    });
    report(result, display, opts.toast ?? false);
    return result;
  } finally {
    inFlight = false;
    useScriptsStore.getState().setRunning(false);
  }
}

function report(r: ScriptRunResult, name: string, toast: boolean): void {
  const store = useScriptsStore.getState();
  const ui = useUIStore.getState();
  if (r.outcome === 'refused') {
    store.print('info', t('scripts.run.refused', '{name} was not run (no permission).', { name }));
    return;
  }
  if (!r.ok) {
    const where = r.errorLine !== undefined ? t('scripts.run.atLine', ' (line {line})', { line: r.errorLine }) : '';
    const message = `${r.error ?? t('scripts.run.failed', 'The script failed.')}${where}`;
    store.print('error', message);
    store.print('info', t('scripts.run.rolledBack', 'Nothing was changed: the run was rolled back.'));
    if (toast) {
      ui.notify({
        level: 'error',
        message: t('scripts.run.failedToast', '{name}: {message}', { name, message }),
        durationMs: 8000,
        action: { label: t('scripts.run.showConsole', 'Show Console'), onSelect: () => useLayoutStore.getState().openPanel(SCRIPT_EDITOR_PANEL) },
      });
    }
    return;
  }
  if (r.value !== null && r.value !== undefined) {
    store.print('result', typeof r.value === 'string' ? r.value : JSON.stringify(r.value));
  }
  store.print('info', t('scripts.run.done', '{name} finished.', { name }));
  if (toast) ui.notify({ level: 'success', message: t('scripts.run.doneToast', 'Ran {name}', { name }), durationMs: 3000 });
}

/** File ▸ Scripts ▸ <a script in the folder>. */
export async function runScriptFromFolder(fileName: string): Promise<void> {
  const file = await api()?.read?.(fileName);
  if (!file) {
    useUIStore.getState().notify({ level: 'error', message: t('scripts.folder.unreadable', 'Could not read {name}.', { name: fileName }), durationMs: 6000 });
    void refreshScriptList();
    return;
  }
  await runUserScript(file.source, file.name, { toast: true });
}

/** File ▸ Scripts ▸ Run Script File…: a native picker, then run. */
export async function runScriptFile(): Promise<void> {
  const pick = api()?.pick;
  if (!pick) return;
  try {
    const file = await pick();
    if (file) await runUserScript(file.source, file.name, { toast: true });
  } catch (err) {
    useUIStore.getState().notify({ level: 'error', message: err instanceof Error ? err.message : String(err), durationMs: 6000 });
  }
}

/** File ▸ Scripts ▸ Open Scripts Folder. */
export async function openScriptsFolder(): Promise<void> {
  const r = await api()?.openFolder?.();
  if (r && !r.ok) {
    useUIStore.getState().notify({ level: 'error', message: t('scripts.folder.openFailed', 'Could not open {path}: {error}', { path: r.path, error: r.error ?? '' }), durationMs: 6000 });
  }
}

let refreshing: Promise<void> | null = null;

/** Rescan the Scripts folder (coalesced: a burst of calls makes one listing). */
export function refreshScriptList(): Promise<void> {
  const list = api()?.list;
  if (!list) return Promise.resolve();
  refreshing ??= list()
    .then((r) => useScriptsStore.getState().setListing(r.folder, r.scripts))
    .catch(() => { /* a listing failure leaves the last list */ })
    .finally(() => { refreshing = null; });
  return refreshing;
}

let focusHooked = false;

/** Rescan when the window regains focus — a script copied in from Explorer appears in the native menu too. */
export function watchScriptsFolder(): void {
  if (focusHooked || typeof window === 'undefined' || !scriptsFolderAvailable()) return;
  focusHooked = true;
  window.addEventListener('focus', () => { void refreshScriptList(); });
  void refreshScriptList();
}

/** The editor's Open: a picker (the Scripts folder first), loaded into the panel. */
export async function openScriptInEditor(): Promise<void> {
  const pick = api()?.pick;
  if (!pick) return;
  try {
    const file = await pick();
    if (file) useScriptsStore.getState().loadFile(file);
  } catch (err) {
    useScriptsStore.getState().print('error', err instanceof Error ? err.message : String(err));
  }
}

/** The editor's Save (Save As when the buffer has no file yet). */
export async function saveScriptFromEditor(saveAs = false): Promise<void> {
  const a = api();
  const s = useScriptsStore.getState();
  if (!a?.save || !a.saveAs) return;
  const result = !saveAs && s.filePath
    ? await a.save({ path: s.filePath, source: s.source })
    : await a.saveAs({ name: s.fileName, source: s.source });
  if (!result) return; // cancelled
  if (!result.ok || !result.name || !result.path) {
    s.print('error', t('scripts.save.failed', 'Could not save: {error}', { error: result.error ?? '' }));
    return;
  }
  const folder = useScriptsStore.getState().folder;
  const inFolder = folder !== null && result.path.slice(0, result.path.length - result.name.length - 1) === folder;
  s.markSaved({ name: result.name, path: result.path, inScriptsFolder: inFolder });
  s.print('info', t('scripts.save.done', 'Saved {name}.', { name: result.name }));
  void refreshScriptList();
}
