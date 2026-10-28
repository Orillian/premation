/**
 * Per-layer label colors (AE-style).
 *
 * The color is stored as `node.color` on the scene-graph node view, which the
 * SceneGraph backs by the engine node's `custom.labelColor` — so it survives
 * the view cache, is captured/restored by sceneProjectIO, and every reader of
 * `node.color` (Scene rows, timeline track headers, clip bars) picks it up on
 * the next scene revision. Clearing (undefined) falls back to the layer kind's
 * default category color (KIND_COLOR / KIND_FILL in sceneDerive).
 *
 * Like Rename / Hide / Solo, this is a direct scene mutation + bumpScene —
 * intentionally not routed through the undo stack (same policy as those ops).
 */

import type { SceneNode } from '@core/types';
import { t } from '@core/i18n';

export interface LabelColor {
  id: string;
  label: string;
  color: string;
}

/** Curated medium, eye-relaxing pastel/matte label palette. */
export const LABEL_COLORS: ReadonlyArray<LabelColor> = [
  { id: 'slate',      get label() { return t('core.labelColor.slateBlue', 'Slate Blue'); },     color: '#5282b8' },
  { id: 'teal',       get label() { return t('core.labelColor.sageTeal', 'Sage Teal'); },      color: '#4ea885' },
  { id: 'coral',      get label() { return t('core.labelColor.warmCoral', 'Warm Coral'); },     color: '#d0705a' },
  { id: 'lavender',   get label() { return t('core.labelColor.softLavender', 'Soft Lavender'); },  color: '#8b75c8' },
  { id: 'steel',      get label() { return t('core.labelColor.steelBlue', 'Steel Blue'); },     color: '#5692a8' },
  { id: 'amber',      get label() { return t('core.labelColor.mutedAmber', 'Muted Amber'); },    color: '#b87e4c' },
  { id: 'olive',      get label() { return t('core.labelColor.softOlive', 'Soft Olive'); },     color: '#7b9c6a' },
  { id: 'magenta',    get label() { return t('core.labelColor.mutedMagenta', 'Muted Magenta'); },  color: '#a86b96' },
  { id: 'aqua',       get label() { return t('core.labelColor.dustyAqua', 'Dusty Aqua'); },     color: '#4b9e99' },
  { id: 'terracotta', get label() { return t('core.labelColor.terracotta', 'Terracotta'); },     color: '#a2775f' },
  { id: 'royal',      get label() { return t('core.labelColor.softRoyal', 'Soft Royal'); },     color: '#587db8' },
  { id: 'coolgray',   get label() { return t('core.labelColor.coolSlate', 'Cool Slate'); },     color: '#7d8ca3' },
];

/** A keyframe's colour label (AE: 1-based into the label palette, 0 = none) as its colour. */
export function keyframeLabelColor(label: number): string | undefined {
  return label > 0 ? LABEL_COLORS[label - 1]?.color : undefined;
}

/** Pure read — the node's explicit label color, or undefined for kind default. */
export function readNodeLabelColor(node: SceneNode): string | undefined {
  return node.color;
}

/**
 * Set (or clear, with undefined) the label color on one or more nodes and
 * bump the scene revision so every projection (Scene tree, timeline tracks,
 * clip bars) re-derives.
 */
export function matchLabelColor(
  nodes: ReadonlyArray<SceneNode>,
  color: string | undefined,
): string[] {
  return nodes.filter((n) => readNodeLabelColor(n) === color).map((n) => n.id);
}
