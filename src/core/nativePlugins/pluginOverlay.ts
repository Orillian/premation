/**
 * Plugin viewer overlays (plugin SDK 1.1, docs/PLUGIN_SDK.md "Viewer overlays"):
 * what a native plugin effect draws over the viewer (PR_CMD_DRAW_OVERLAY), as
 * the engine pushes it with the frame (overlay kind `plugin`), and the commands
 * a handle drag sends (`dragEffectOverlay`, PR_CMD_OVERLAY_DRAG).
 *
 * Each item is in LAYER px (mapped with the layer, as a mask is) or, SDK 1.2
 * (`space` = OVERLAY_SPACE_COMP), in COMPOSITION px — a point the plugin
 * projected through the comp camera itself (model3d's handle on its model),
 * mapped by the viewer's comp → screen only. A handle's drag reports the
 * pointer in the handle's own space.
 *
 * Pure: projection in, SVG data and commands out. The component is
 * src/layout/Workspace/PluginOverlay.tsx. No plugin code runs in the page —
 * the engine asked the plugin; this only draws its list.
 */

import type { Command, OverlayPluginItem } from '@motion/engine-api';

export interface Point {
  x: number;
  y: number;
}

/** PR_OVERLAY_SPACE_*: what an item's points are in. */
export const OVERLAY_SPACE_LAYER = 0;
export const OVERLAY_SPACE_COMP = 1;

/** A drawable, already in screen px. `local` is the handle in its own `space` (layer or comp px). */
export type OverlayShape =
  | { kind: 'path'; d: string; color: string | null }
  | { kind: 'handle'; effect: string; handle: number; shape: number; at: Point; local: Point; space: number; color: string | null };

type ToScreen = (x: number, y: number) => Point;

/** Straight rgba 0..1 → CSS; null = the viewer's handle colour. */
export function cssColor(c: readonly number[]): string | null {
  if (c.length < 4) return null;
  const b = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgba(${b(c[0]!)}, ${b(c[1]!)}, ${b(c[2]!)}, ${Math.min(1, Math.max(0, c[3]!)).toFixed(3)})`;
}

/**
 * The engine's items → screen shapes: layer-px items through `toScreen` (null = the layer has no
 * mapping yet: they are skipped), comp-px items (SDK 1.2) through `compToScreen`.
 */
export function overlayShapes(
  items: readonly OverlayPluginItem[],
  toScreen: ToScreen | null,
  compToScreen: ToScreen | null = null,
): OverlayShape[] {
  const out: OverlayShape[] = [];
  for (const i of items) {
    const space = i.space === OVERLAY_SPACE_COMP ? OVERLAY_SPACE_COMP : OVERLAY_SPACE_LAYER;
    const map = space === OVERLAY_SPACE_COMP ? compToScreen : toScreen;
    if (!map) continue;
    const color = cssColor(i.color);
    if (i.kind === 'handle' && i.points.length >= 2) {
      const local = { x: i.points[0]!, y: i.points[1]! };
      out.push({ kind: 'handle', effect: i.effect, handle: i.handle, shape: i.shape, at: map(local.x, local.y), local, space, color });
      continue;
    }
    if ((i.kind === 'line' || i.kind === 'path') && i.points.length >= 4) {
      let d = '';
      for (let k = 0; k + 1 < i.points.length; k += 2) {
        const s = map(i.points[k]!, i.points[k + 1]!);
        d += `${k === 0 ? 'M' : 'L'}${s.x.toFixed(2)} ${s.y.toFixed(2)}`;
      }
      if (i.kind === 'path' && i.closed) d += 'Z';
      out.push({ kind: 'path', d, color });
    }
  }
  return out;
}

/** The handle under `p` (screen px) within `radius`, nearest first. */
export function pickHandle(shapes: readonly OverlayShape[], p: Point, radius: number): Extract<OverlayShape, { kind: 'handle' }> | null {
  let best: Extract<OverlayShape, { kind: 'handle' }> | null = null;
  let bestD = radius * radius;
  for (const s of shapes) {
    if (s.kind !== 'handle') continue;
    const d = (s.at.x - p.x) ** 2 + (s.at.y - p.y) ** 2;
    if (d <= bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

export const DRAG_BEGIN = 0;
export const DRAG_MOVE = 1;
export const DRAG_END = 2;

/**
 * One step of a handle drag, in the handle's own space (`space`: layer px, or SDK 1.2 comp px).
 * The caller sends a drag's steps inside one gesture.
 */
export function dragCommand(
  layer: string,
  effect: string,
  handle: number,
  at: Point,
  start: Point,
  phase: typeof DRAG_BEGIN | typeof DRAG_MOVE | typeof DRAG_END,
  space: number = OVERLAY_SPACE_LAYER,
): Command {
  return {
    type: 'dragEffectOverlay',
    group: { layer, path: effect },
    handle,
    x: at.x,
    y: at.y,
    startX: start.x,
    startY: start.y,
    phase,
    space,
  } as Command;
}
