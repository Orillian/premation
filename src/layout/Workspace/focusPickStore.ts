/**
 * Pick focus on canvas (camera program U6, 2026-10-14): a ONE-SHOT pick.
 *
 * The crosshair beside a camera's Focus Distance arms it; the next left
 * click in the viewport is not a selection but "focus here" — the layer
 * under the pointer gets the camera's focal plane (`setFocusDistanceToLayer`,
 * the axial depth the renderer defocuses by, keyed when Focus Distance is
 * animated or Auto-Keyframe is on) and the pick disarms. Esc, a second
 * press, or arming another camera, cancels. While armed the viewport cursor
 * is a crosshair (useWorkspace subscribes), so the mode shows where the
 * click lands.
 *
 * Interaction state of one view, like `gradientEditStore`: never the document.
 */

import { create } from 'zustand';
import { setFocusDistanceToLayer } from '@core/scene/cameraCommands';
import { documentMirror } from '@stores/documentMirror';
import { useUIStore } from '@stores/uiStore';
import { t } from '@core/i18n';

interface FocusPickState {
  /** The camera whose Focus Distance the next viewport click sets (null: not armed). */
  camera: string | null;
  arm: (camera: string) => void;
  cancel: () => void;
}

/**
 * Esc cancels an armed pick wherever focus is. Installed for exactly as long
 * as the pick is armed, in the CAPTURE phase so the same Esc does not also
 * clear the selection (which would unmount the Inspector that armed it).
 */
function onEscape(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  useFocusPickStore.getState().cancel();
}

export const useFocusPickStore = create<FocusPickState>((set) => ({
  camera: null,
  arm: (camera) => {
    window.addEventListener('keydown', onEscape, true);
    set({ camera });
  },
  cancel: () => {
    window.removeEventListener('keydown', onEscape, true);
    set({ camera: null });
  },
}));

function notify(message: string, level: 'info' | 'success' | 'warning'): void {
  useUIStore.getState().notify({ level, message, durationMs: 4000 });
}

/**
 * The viewport's half of the pick: called with the layer under a left click
 * (undefined: empty canvas) while armed. Consumes the click — it never also
 * selects — disarms, and sets the focus distance (one undo entry). Resolves
 * to the depth written, or null when nothing was (no layer under the click,
 * the camera itself, or a layer behind the camera — each toasted).
 */
export async function completeFocusPick(hit: string | undefined, time: number): Promise<number | null> {
  const cam = useFocusPickStore.getState().camera;
  useFocusPickStore.getState().cancel();
  if (!cam) return null;
  if (!hit || hit === cam) {
    notify(t('workspace.focusPick.cancelled', 'Focus pick cancelled — click a layer to focus on it'), 'info');
    return null;
  }
  const depth = await setFocusDistanceToLayer(cam, hit, time);
  const name = documentMirror().layer(hit)?.name ?? t('workspace.focusPick.theLayer', 'the layer');
  notify(
    depth === null
      ? t('workspace.focusPick.behindCamera', '{name} is behind the camera', { name })
      : t('workspace.focusPick.focused', 'Focus on {name} — {depth} px', { name, depth: Math.round(depth) }),
    depth === null ? 'warning' : 'success',
  );
  return depth;
}
