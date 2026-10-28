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

import type { CommandId, KeyChord } from '@app-types/common';
import { chordKey, getCommandRegistry } from '@core/commands/Command';
import { commandLabel } from '@core/commands/commandLabel';
import { chordFromEvent, getCommandSystem } from '@core/commands/CommandSystem';
import { ensureCommandsRegistered } from '@core/commands/ensureCommandsRegistered';
import { formatChord } from '@core/commands/formatChord';
import { getShortcutOverrides, resolveChord } from '@core/commands/shortcutOverrides';
import { parseSelectionKey, resolveSelectionKey } from '@core/mirror/keySelection';
import { propRefForTrack } from '@core/engine/propRefs';
import {
  panelMayRunEditorCommand,
  type PanelShortcutBinding,
  type ToolPanelKey,
  type ToolPanelProperty,
} from '@core/nativePlugins/pluginToolPanel';
import { readPersisted, writePersisted } from '@core/settings/persistedValue';
import { documentMirror } from '@stores/documentMirror';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';
import { usePropertySelectionStore } from '@stores/propertySelectionStore';
import { runUserScript } from '@layout/Scripts/userScripts';

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

/**
 * Whether the user asked for what the panel is about to do: the panel's frame has the focus (a
 * click in it), or the editor just delivered one of the panel's shortcuts to it (`granted` until).
 */
export function panelActionAllowed(frame: HTMLIFrameElement | null, grantedUntil: number): boolean {
  return !!frame && (frame.ownerDocument.activeElement === frame || performance.now() < grantedUntil);
}

/** Run `id` for the panel in `frame`. Throws with the reason it did not run. */
export async function runPanelEditorCommand(id: string, frame: HTMLIFrameElement | null, grantedUntil = 0): Promise<void> {
  if (!panelActionAllowed(frame, grantedUntil)) throw new Error('click in the panel to run a command');
  if (!panelMayRunEditorCommand(id)) throw new Error(`a panel may not run '${id}'`);
  ensureCommandsRegistered();
  const cmd = getCommandRegistry().get(id as CommandId);
  if (!cmd) throw new Error(`no command '${id}'`);
  if (cmd.enabled && !cmd.enabled()) throw new Error(`'${commandLabel(cmd)}' is not available now`);
  await getCommandSystem().execute(id as CommandId);
}

/** The selected keyframes and property rows, as engine ids and paths (what a panel can edit). */
export function panelSelection(): { keyframes: ToolPanelKey[]; properties: ToolPanelProperty[] } {
  const m = documentMirror();
  const keyframes: ToolPanelKey[] = [];
  for (const id of useKeyframeSelectionStore.getState().ids) {
    const sel = parseSelectionKey(id);
    const hit = sel ? resolveSelectionKey(m, sel) : null;
    if (!sel || !hit) continue;
    keyframes.push({ layer: sel.layer, key: sel.keyId, path: hit.path, ...(sel.member !== undefined ? { member: sel.member } : {}) });
  }
  const properties: ToolPanelProperty[] = [];
  for (const e of usePropertySelectionStore.getState().entries) {
    const r = propRefForTrack(e.nodeId, e.prop);
    if (r) properties.push({ layer: r.ref.layer, path: r.ref.path, member: r.member });
  }
  return { keyframes, properties };
}

/** Run a panel's script as File ▸ Scripts would (consent prompt, console, one undo step). */
export async function runPanelScript(source: string, name: string, frame: HTMLIFrameElement | null, grantedUntil = 0): Promise<unknown> {
  if (!panelActionAllowed(frame, grantedUntil)) throw new Error('click in the panel to run a script');
  const r = await runUserScript(source, name);
  if (!r) throw new Error('another script is running');
  if (!r.ok) throw new Error(r.error ?? 'the script failed');
  return r.value ?? null;
}

const keyOf = (b: KeyChord): string => chordKey(b);

/**
 * The bindings the editor will deliver to the panel: each must not collide with an editor command's
 * chord (as the user has them) or another binding. Answers the refused ones with the reason.
 */
export function acceptPanelShortcuts(bindings: readonly PanelShortcutBinding[]): {
  accepted: Map<string, string>;
  refused: { id: string; reason: string }[];
} {
  ensureCommandsRegistered();
  const overrides = getShortcutOverrides();
  const taken = new Map<string, string>();
  for (const c of getCommandRegistry().all()) {
    const chord = resolveChord(c.id as unknown as string, c.shortcut, overrides);
    if (chord) taken.set(keyOf(chord), commandLabel(c));
  }
  const accepted = new Map<string, string>();
  const refused: { id: string; reason: string }[] = [];
  for (const b of bindings) {
    const k = keyOf(b);
    const owner = taken.get(k);
    if (owner) refused.push({ id: b.id, reason: `${formatChord(b)} is ${owner}` });
    else if (accepted.has(k)) refused.push({ id: b.id, reason: `${formatChord(b)} is used twice` });
    else accepted.set(k, b.id);
  }
  return { accepted, refused };
}

/** The panel binding a key press means, if any (never while typing in a field). */
export function panelShortcutFor(e: KeyboardEvent, accepted: ReadonlyMap<string, string>): string | null {
  if (accepted.size === 0 || e.repeat) return null;
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return null;
  return accepted.get(chordKey(chordFromEvent(e))) ?? null;
}

/** Save `text` as a file the user places (the browser's / Electron's save dialog). */
export function savePanelFile(name: string, text: string, frame: HTMLIFrameElement | null, grantedUntil = 0): void {
  if (!panelActionAllowed(frame, grantedUntil)) throw new Error('click in the panel to save a file');
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Let the user pick a text file (≤ 1 MiB) and hand its text to the panel; null = cancelled. */
export function openPanelFile(accept: string, frame: HTMLIFrameElement | null, grantedUntil = 0): Promise<{ name: string; text: string } | null> {
  if (!panelActionAllowed(frame, grantedUntil)) return Promise.reject(new Error('click in the panel to open a file'));
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      if (file.size > 1024 * 1024) return reject(new Error('the file is larger than 1 MiB'));
      file.text().then((text) => resolve({ name: file.name, text }), reject);
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}
