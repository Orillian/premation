/**
 * Plugin SDK 1.3 — a native plugin's box in its effect card (PR_PARAM_CUSTOM_UI,
 * docs/PLUGIN_SDK.md "Custom UI in Effect Controls"): AE's custom Effect Controls
 * UI (PF_PUI_CONTROL + PF_Cmd_EVENT), without plugin code in the UI process.
 *
 *   drawEffectParamUi   the engine runs PR_CMD_DRAW_PARAM_UI and answers the draw list
 *                       (lines, paths, fills, handles, text) in box px
 *   dragEffectParamUi   a handle drag (PR_CMD_PARAM_UI_DRAG); the card sends a drag's
 *                       steps inside one gesture — one undo entry
 *
 * An item without a colour takes the editor theme's, so a plugin that draws with
 * NULL colours matches dark, light and high contrast. Pure: no React, no engine
 * import (layout/Effects/PluginCustomUi.tsx draws it).
 */

import type { Command, ParamUiItem } from '@motion/engine-api';
import { DRAG_BEGIN, DRAG_END, DRAG_MOVE } from './pluginOverlay';

export { DRAG_BEGIN, DRAG_END, DRAG_MOVE };

export type ParamUiPhase = typeof DRAG_BEGIN | typeof DRAG_MOVE | typeof DRAG_END;

/** One step of a box handle's drag, in box px. */
export function paramUiDragCommand(
  layer: string,
  effectId: string,
  key: string,
  handle: number,
  at: { x: number; y: number },
  start: { x: number; y: number },
  phase: ParamUiPhase,
  width: number,
): Command {
  return {
    type: 'dragEffectParamUi',
    group: { layer, path: `effects/${effectId}` },
    key,
    handle,
    x: at.x,
    y: at.y,
    startX: start.x,
    startY: start.y,
    phase,
    width,
  } as Command;
}

/** The theme's colour for an item the plugin drew without one (CSS custom properties). */
const THEME_COLOR: Record<string, string> = {
  line: 'var(--color-text-secondary)',
  path: 'var(--color-text-secondary)',
  fill: 'var(--color-surface-2)',
  text: 'var(--color-text-primary)',
  handle: 'var(--color-primary)',
};

/** An item's colour as CSS: the plugin's straight RGBA 0..1, else the theme's. */
export function paramUiColor(item: Pick<ParamUiItem, 'kind' | 'color'>): string {
  const c = item.color;
  if (c && c.length >= 3 && c.slice(0, 4).every((v) => Number.isFinite(v))) {
    const ch = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
    const a = c.length >= 4 ? Math.min(1, Math.max(0, c[3]!)) : 1;
    return `rgba(${ch(c[0]!)}, ${ch(c[1]!)}, ${ch(c[2]!)}, ${a})`;
  }
  return THEME_COLOR[item.kind] ?? 'var(--color-text-secondary)';
}

/** SVG path data for a line / path / fill's points. */
export function paramUiPathData(item: Pick<ParamUiItem, 'points' | 'closed' | 'kind'>): string {
  const p = item.points;
  if (p.length < 4) return '';
  let d = `M${p[0]} ${p[1]}`;
  for (let i = 2; i + 1 < p.length; i += 2) d += `L${p[i]} ${p[i + 1]}`;
  return item.closed || item.kind === 'fill' ? `${d}Z` : d;
}

/** How near (px) a press must land on a handle to grab it. */
export const HANDLE_GRAB = 7;

/** The topmost handle under box point (x, y), or null. Later items draw on top, so they win. */
export function paramUiHandleAt(items: readonly ParamUiItem[], x: number, y: number): ParamUiItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind !== 'handle' || it.points.length < 2) continue;
    if (Math.hypot(it.points[0]! - x, it.points[1]! - y) <= HANDLE_GRAB) return it;
  }
  return null;
}
