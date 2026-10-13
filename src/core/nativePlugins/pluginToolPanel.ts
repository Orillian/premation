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
 *   editor → panel
 *     { type: 'context', plugin, comp, layers, time } on ready and after every document,
 *                                                       selection or time change
 *     { type: 'reply', id, ok, result? | error? }
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

export type ToolPanelMessage =
  | { type: 'ready' }
  | { type: 'shortcut'; action: PanelShortcut }
  | { id: number; type: 'query'; request: Query }
  | { id: number; type: 'command'; commands: Command[]; label: string };

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

export interface ToolPanelContext {
  plugin: string;
  comp: string;
  layers: readonly string[];
  /** Composition time, flicks. */
  time: number;
}

export function toolPanelContext(c: ToolPanelContext): Record<string, unknown> {
  return { premation: TOOL_PANEL_PROTOCOL, type: 'context', plugin: c.plugin, comp: c.comp, layers: [...c.layers], time: c.time };
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
