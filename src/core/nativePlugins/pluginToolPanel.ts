/**
 * P7d — a plugin's dockable panel that is not tied to an effect (manifest
 * `panels`, docs/PLUGIN_SDK.md "Panels"). The page is the bundle's own HTML in
 * the P5 sandbox (`plugin-ui://<id>/<page>`, sandbox="allow-scripts", no
 * network: electron/pluginPanelProtocol.ts); it reaches the document only
 * through this message API, which is the ENGINE API:
 *
 *   panel → editor (postMessage, `premation: 1`)
 *     { type: 'ready' }                              → `context`
 *     { id, type: 'query', request }                 → the query's result
 *     { id, type: 'command', request, label? }       → ONE edit command, origin `plugin`,
 *                                                       ONE undo entry
 *     { id, type: 'command', commands: [...], label } → several, still ONE undo entry
 *     { type: 'shortcut', action: 'undo' | 'redo' }  → Edit ▸ Undo / Redo (a key press in the
 *                                                       frame never reaches the editor's shortcuts)
 *     { id, type: 'settings', set? }                 → the plugin's saved settings (editor prefs,
 *                                                       per user, never the document); `set`
 *                                                       replaces them first
 *     { id, type: 'listEditorCommands' }            → the editor commands a panel may run
 *     { id, type: 'editorCommand', command }         → run one, as its menu item would — only while
 *                                                       the frame has the focus (a click in the panel)
 *     { id, type: 'runScript', source, name }        → File ▸ Scripts' run (consent, one undo step)
 *     { id, type: 'setShortcuts', shortcuts }        → editor-wide chords while the panel is open
 *     { id, type: 'saveFile' | 'openFile', … }       → the save / open dialogs, text ≤ 1 MiB
 *   editor → panel
 *     { type: 'context', plugin, comp, layers, time, keyframes, properties } on ready and after
 *                                                       every document, selection or time change
 *     { type: 'invoke', id }                         a bound shortcut was pressed
 *     { type: 'reply', id, ok, result? | error? }
 *     { type: 'theme', theme }                       the editor's look (panelTheme.ts): on load,
 *                                                       on ready and on every change
 *
 * Only EDIT commands pass (no undo / open / save / transport / jobs): what a
 * panel does is always an undoable edit of the open document. Requests are
 * the engine API's TypeScript object form (packages/engine-api types).
 *
 * Pure (no React, no engine import): PluginToolPanel.tsx does the I/O.
 */

import { COMMANDS, QUERIES, type Command, type CommandType, type Query, type QueryType } from '@motion/engine-api';
import { PANEL_SHORTCUTS, type PanelShortcut } from './pluginPanel';

export const TOOL_PANEL_PROTOCOL = 1;
/** A request's JSON size limit (a panel never needs more; the frame is untrusted). */
export const MAX_TOOL_REQUEST = 1024 * 1024;
export const MAX_TOOL_BATCH = 256;
/** A plugin's saved settings, as JSON (a toolbar's buttons fit many times over). */
export const MAX_PANEL_SETTINGS = 256 * 1024;

export type ToolPanelMessage =
  | { type: 'ready' }
  | { type: 'shortcut'; action: PanelShortcut }
  | { id: number; type: 'query'; request: Query }
  | { id: number; type: 'command'; commands: Command[]; label: string }
  | { id: number; type: 'settings'; set?: Record<string, unknown> }
  | { id: number; type: 'listEditorCommands' }
  | { id: number; type: 'editorCommand'; command: string }
  | { id: number; type: 'runScript'; source: string; name: string }
  | { id: number; type: 'setShortcuts'; shortcuts: PanelShortcutBinding[] }
  | { id: number; type: 'saveFile'; name: string; text: string }
  | { id: number; type: 'openFile'; accept: string };

/** A key chord a panel binds editor-wide while it is open; the editor answers `{ type: 'invoke', id }`. */
export interface PanelShortcutBinding {
  id: string;
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export const MAX_PANEL_SHORTCUTS = 200;
/** A script or a saved file, as text. */
export const MAX_PANEL_TEXT = 1024 * 1024;

function bindingOf(v: unknown): PanelShortcutBinding | null {
  if (!isObject(v) || typeof v.id !== 'string' || !v.id || v.id.length > 100) return null;
  if (typeof v.key !== 'string' || !v.key || v.key.length > 20) return null;
  const ctrl = v.ctrl === true;
  const alt = v.alt === true;
  const meta = v.meta === true;
  // A bare key would steal typing and the editor's own one-key tools.
  if (!ctrl && !alt && !meta && !/^F([1-9]|1[0-9]|2[0-4])$/.test(v.key)) return null;
  return { id: v.id, key: v.key, ctrl, alt, shift: v.shift === true, meta };
}

/**
 * Editor command ids a panel may never run: files, the app, the account, help, plugin
 * management (a panel must not install, sign in, save over, quit or open URLs). Prefixes.
 */
const PANEL_DENIED_COMMANDS = ['file.', 'app.', 'account.', 'help.', 'plugins.', 'plugin.', 'test.', 'window.', 'auth.', 'update.'];

export function panelMayRunEditorCommand(id: string): boolean {
  const lower = id.toLowerCase();
  return !PANEL_DENIED_COMMANDS.some((p) => lower.startsWith(p));
}

export type ToolPanelParse = ToolPanelMessage | { id: number; type: 'invalid'; error: string } | null;

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function sizeOk(v: unknown): boolean {
  try {
    return JSON.stringify(v).length <= MAX_TOOL_REQUEST;
  } catch {
    return false;
  }
}

/** An edit command a panel may send ('edit' kind in the schema), or why not. */
export function checkPanelCommand(c: unknown): string | null {
  if (!isObject(c) || typeof c.type !== 'string') return 'a command is an object with a "type"';
  const info = (COMMANDS as Record<string, { kind: string } | undefined>)[c.type];
  if (!info) return `unknown command '${c.type}'`;
  if (info.kind !== 'edit') return `'${c.type}' is not an edit command`;
  return null;
}

/**
 * A message from the frame → what it asks; `invalid` (with the request id, to answer it) when it is
 * malformed; null when it is not ours at all. Never throws: the frame is untrusted.
 */
export function parseToolPanelMessage(raw: unknown): ToolPanelParse {
  if (!isObject(raw) || raw.premation !== TOOL_PANEL_PROTOCOL || typeof raw.type !== 'string') return null;
  if (raw.type === 'ready') return { type: 'ready' };
  if (raw.type === 'shortcut') {
    return PANEL_SHORTCUTS.includes(raw.action as PanelShortcut) ? { type: 'shortcut', action: raw.action as PanelShortcut } : null;
  }
  const id = raw.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) return null;
  const invalid = (error: string) => ({ id, type: 'invalid' as const, error });
  if (raw.type === 'query') {
    const q = raw.request;
    if (!isObject(q) || typeof q.type !== 'string' || !(q.type in QUERIES)) return invalid('unknown query');
    if (!sizeOk(q)) return invalid('the request is too large');
    return { id, type: 'query', request: q as unknown as Query };
  }
  if (raw.type === 'command') {
    const list: unknown[] = Array.isArray(raw.commands) ? raw.commands : raw.request !== undefined ? [raw.request] : [];
    if (list.length === 0 || list.length > MAX_TOOL_BATCH) return invalid(`send 1-${MAX_TOOL_BATCH} commands`);
    for (const c of list) {
      const why = checkPanelCommand(c);
      if (why) return invalid(why);
    }
    // runPluginCommand logs its own edits; inside a batch the log would replay the plugin.
    if (list.length > 1 && list.some((c) => (c as { type: string }).type === 'runPluginCommand')) {
      return invalid('runPluginCommand goes alone');
    }
    if (!sizeOk(list)) return invalid('the request is too large');
    const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 80) : '';
    return { id, type: 'command', commands: list as Command[], label };
  }
  if (raw.type === 'settings') {
    if (raw.set === undefined) return { id, type: 'settings' };
    if (!isObject(raw.set)) return invalid('settings are an object');
    let size = Infinity;
    try {
      size = JSON.stringify(raw.set).length;
    } catch {
      /* not JSON */
    }
    if (size > MAX_PANEL_SETTINGS) return invalid('the settings are too large');
    return { id, type: 'settings', set: JSON.parse(JSON.stringify(raw.set)) as Record<string, unknown> };
  }
  if (raw.type === 'listEditorCommands') return { id, type: 'listEditorCommands' };
  if (raw.type === 'editorCommand') {
    if (typeof raw.command !== 'string' || !raw.command || raw.command.length > 200) return invalid('name the command');
    if (!panelMayRunEditorCommand(raw.command)) return invalid(`a panel may not run '${raw.command}'`);
    return { id, type: 'editorCommand', command: raw.command };
  }
  if (raw.type === 'runScript') {
    if (typeof raw.source !== 'string' || !raw.source.trim()) return invalid('the script is empty');
    if (raw.source.length > MAX_PANEL_TEXT) return invalid('the script is too large');
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : 'Panel script';
    return { id, type: 'runScript', source: raw.source, name };
  }
  if (raw.type === 'setShortcuts') {
    if (!Array.isArray(raw.shortcuts) || raw.shortcuts.length > MAX_PANEL_SHORTCUTS) return invalid(`send 0-${MAX_PANEL_SHORTCUTS} shortcuts`);
    const shortcuts: PanelShortcutBinding[] = [];
    for (const s of raw.shortcuts) {
      const b = bindingOf(s);
      if (!b) return invalid('a shortcut is { id, key, ctrl?, alt?, shift?, meta? } with Ctrl, Alt or Cmd (or an F key)');
      shortcuts.push(b);
    }
    return { id, type: 'setShortcuts', shortcuts };
  }
  if (raw.type === 'saveFile') {
    if (typeof raw.text !== 'string' || raw.text.length > MAX_PANEL_TEXT) return invalid('the file is text up to 1 MiB');
    // A file NAME only: no folders, nothing Windows refuses, no control characters.
    const name = typeof raw.name === 'string' ? [...raw.name].map((c) => (c < ' ' || '\\/:*?"<>|'.includes(c) ? '_' : c)).join('').slice(0, 120) : '';
    if (!name) return invalid('name the file');
    return { id, type: 'saveFile', name, text: raw.text };
  }
  if (raw.type === 'openFile') {
    const accept = typeof raw.accept === 'string' ? raw.accept.slice(0, 200) : '';
    return { id, type: 'openFile', accept };
  }
  return invalid(`unknown message '${raw.type}'`);
}

/** The undo entry's label: the panel's, else the command's own name ("Rename Layer"). */
export function toolPanelLabel(commands: readonly Command[], label: string, panelName: string): string {
  if (label) return label;
  if (commands.length === 1) {
    const t = commands[0]!.type as CommandType;
    return t.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
  }
  return panelName;
}

/** A selected keyframe as the engine names it (`updateKeyframes` takes `key`). */
export interface ToolPanelKey {
  layer: string;
  key: string;
  /** The API property path the key is on. */
  path: string;
  /** The member row (X of Position = 0) when one dimension's diamond is selected. */
  member?: number;
}

/** A selected property row, as an engine PropRef plus its member. */
export interface ToolPanelProperty {
  layer: string;
  path: string;
  member: number;
}

export interface ToolPanelContext {
  plugin: string;
  comp: string;
  layers: readonly string[];
  /** Composition time, flicks. */
  time: number;
  keyframes?: readonly ToolPanelKey[];
  properties?: readonly ToolPanelProperty[];
}

export function toolPanelContext(c: ToolPanelContext): Record<string, unknown> {
  return {
    premation: TOOL_PANEL_PROTOCOL,
    type: 'context',
    plugin: c.plugin,
    comp: c.comp,
    layers: [...c.layers],
    time: c.time,
    keyframes: [...(c.keyframes ?? [])],
    properties: [...(c.properties ?? [])],
  };
}

export function toolPanelReply(id: number, r: { ok: true; result: unknown } | { ok: false; error: string }): Record<string, unknown> {
  return r.ok
    ? { premation: TOOL_PANEL_PROTOCOL, type: 'reply', id, ok: true, result: r.result }
    : { premation: TOOL_PANEL_PROTOCOL, type: 'reply', id, ok: false, error: r.error };
}

/** `plugin-ui://<id>/<page>` (the host is the id lower-cased, as the protocol serves it). */
export function toolPanelUrl(plugin: string, page: string): string {
  return `plugin-ui://${plugin.toLowerCase()}/${page.split('/').map(encodeURIComponent).join('/')}`;
}

/** Narrow a QueryType at runtime (tests). */
export function isQueryType(t: string): t is QueryType {
  return t in QUERIES;
}
