/**
 * Whether the viewer draws a kind of layer control right now — After Effects'
 * View ▸ Show Layer Controls (Ctrl+Shift+H) over its View Options (which
 * kinds), plus "while playing".
 *
 * One rule for every overlay (the canvas chrome in useWorkspace, the SVG
 * overlays, the 3D gizmo, the camera/light grab dots), so a toggle cannot
 * hide the selection box and leave a light's dot dancing over the shot:
 *
 *   shown(kind) = showLayerControls
 *               ∧ layerControlKinds[kind]
 *               ∧ (not playing ∨ layerControlsWhilePlaying)
 *
 * Editor state only: nothing here enters the document or changes a render.
 */

import { useProjectStore } from './projectStore';
import { usePreferenceStore, type LayerControlKinds, type Preferences } from './preferenceStore';

export type LayerControlKind = keyof LayerControlKinds;

export const LAYER_CONTROL_KINDS: readonly LayerControlKind[] = [
  'handles',
  'masks',
  'lightsCameras',
  'gizmo3d',
  'effectControls',
];

type ControlPrefs = Pick<Preferences, 'showLayerControls' | 'layerControlsWhilePlaying' | 'layerControlKinds'>;

/** The rule itself, pure. A kind missing from an older persisted profile reads as on. */
export function layerControlVisible(prefs: ControlPrefs, kind: LayerControlKind, playing: boolean): boolean {
  if (!prefs.showLayerControls) return false;
  if (playing && !prefs.layerControlsWhilePlaying) return false;
  return prefs.layerControlKinds?.[kind] !== false;
}

/** Whether the active composition tab is playing. */
export function activeTabPlaying(): boolean {
  const s = useProjectStore.getState();
  return s.activeTabId ? s.tabs[s.activeTabId]?.playing === true : false;
}

/**
 * The master switch and the playing rule alone, for chrome whose own toggle
 * lives elsewhere (the motion path's View ▸ Motion Paths).
 */
export function layerControlsOn(): boolean {
  const p = usePreferenceStore.getState();
  return p.showLayerControls && (p.layerControlsWhilePlaying || !activeTabPlaying());
}

/** `layerControlVisible` for the active tab, now (paint code, event handlers). */
export function layerControlShown(kind: LayerControlKind): boolean {
  return layerControlVisible(usePreferenceStore.getState(), kind, activeTabPlaying());
}

/** `layerControlShown` as a hook: re-renders on the toggles and on play / stop. */
export function useLayerControlShown(kind: LayerControlKind): boolean {
  const playing = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.playing === true : false));
  const master = usePreferenceStore((s) => s.showLayerControls);
  const whilePlaying = usePreferenceStore((s) => s.layerControlsWhilePlaying);
  const kinds = usePreferenceStore((s) => s.layerControlKinds);
  return layerControlVisible({ showLayerControls: master, layerControlsWhilePlaying: whilePlaying, layerControlKinds: kinds }, kind, playing);
}

/** View ▸ Show Layer Controls. */
export function toggleLayerControls(): void {
  const p = usePreferenceStore.getState();
  p.set('showLayerControls', !p.showLayerControls);
}

/** View Options: one kind on or off. */
export function setLayerControlKind(kind: LayerControlKind, on: boolean): void {
  const p = usePreferenceStore.getState();
  p.set('layerControlKinds', { ...DEFAULT_KINDS, ...p.layerControlKinds, [kind]: on });
}

const DEFAULT_KINDS: LayerControlKinds = {
  handles: true,
  masks: true,
  lightsCameras: true,
  gizmo3d: true,
  effectControls: true,
};
