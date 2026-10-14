/**
 * "What a drag edits" — the camera-navigation badge (camera program U1,
 * 2026-10-14).
 *
 * The same Alt+drag (or C-key camera tool drag) does two very different
 * things depending on the 3D View: in Active Camera or a camera's own view it
 * WRITES the camera layer — it moves the shot, and keys it when the camera is
 * animated or Auto-Keyframe is on — while in a custom or orthographic view it
 * only moves the preview, and nothing in the document changes. Nothing on
 * screen said which, so a user framing a shot in Custom View 1 found it
 * unchanged in the render, and one "just looking around" in Active Camera
 * found keys on their camera.
 *
 * So while a camera tool is armed, or Alt is held, a small badge at the foot
 * of the viewport names the target and the consequence:
 *
 *   Camera 1 · moves the shot                (Active Camera / camera views)
 *   Camera 1 · moves the shot · keyframing   (…and the drag will key it)
 *   Custom View 1 · preview only             (custom / orthographic views)
 *
 * Nothing draws in a scene-camera view with no camera to look through — the
 * drag does nothing there, and `navUnavailableNow` toasts why on the press.
 * Pointer-transparent, like the HUD: it must never swallow the drag it
 * describes. React renders on the tool / view / Alt change and on the
 * camera's navigation tracks' key state, never per drag step.
 */

import { useEffect, useState } from 'react';
import { useGuidesStore, type Camera3dMode } from '@stores/guidesStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useActiveCompId, useMirrorSelect, useMirrorTrackWatch } from '@hooks/useMirror';
import { documentMirror } from '@stores/documentMirror';
import { mirrorLookThroughCamera, mirrorLookThroughCameras } from '@core/mirror/cameras';
import { trackRefIn } from '@core/mirror/trackIndex';
import { cameraViewNodeId, isSceneCameraView } from '@core/scene/cameraViewMode';
import { cameraViewLabel } from '@layout/TopNav/ViewControls';
import styles from './CameraNavBadge.module.css';

/**
 * The camera tracks a viewport camera drag writes: orbit (yaw / pitch),
 * track and dolly (the eye, and the Point of Interest of a two-node camera).
 * When any of them is animated the drag lands as a key, not a static value.
 */
export const CAMERA_NAV_TRACKS: readonly string[] = ['x', 'y', 'z', 'orbitYaw', 'orbitPitch', 'poiX', 'poiY', 'poiZ'];

export interface CameraNavBadgeInput {
  /** The main viewport's 3D View. */
  mode: Camera3dMode;
  /** The camera a scene-camera view looks through (null: none). */
  cameraName: string | null;
  /** The drag will key the camera (a navigation track is animated, or Auto-Keyframe is on). */
  keyframing: boolean;
  /** The label of a custom / orthographic view ("Custom View 1", "Front"). */
  viewLabel: string;
}

/** The badge's text, or null when a drag here moves nothing (no camera to look through). Pure. */
export function cameraNavBadgeText({ mode, cameraName, keyframing, viewLabel }: CameraNavBadgeInput): string | null {
  if (!isSceneCameraView(mode)) return `${viewLabel} · preview only`;
  if (cameraName === null) return null;
  const name = cameraName.trim() ? cameraName : 'Camera';
  return keyframing ? `${name} · moves the shot · keyframing` : `${name} · moves the shot`;
}

/** Alt held (any window focus loss lets go — a keyup in another window never arrives). */
function useAltHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent): void => { if (e.key === 'Alt') setHeld(true); };
    const up = (e: KeyboardEvent): void => { if (e.key === 'Alt') setHeld(false); };
    const blur = (): void => setHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);
  return held;
}

/** The badge's body: mounted only while it shows, so an idle viewport subscribes to nothing. */
function Badge({ mode }: { mode: Camera3dMode }): JSX.Element | null {
  const comp = useActiveCompId();
  const camera = useMirrorSelect(['doc'], (m) =>
    isSceneCameraView(mode)
      ? (mirrorLookThroughCamera(m, cameraViewNodeId(mode), comp) ?? mirrorLookThroughCameras(m, comp)[0] ?? null)
      : null,
  );
  const camId = camera?.id ?? null;
  useMirrorTrackWatch(camId ? [camId] : [], CAMERA_NAV_TRACKS);
  const autoKey = usePreferenceStore((s) => s.timelineAutoKeyframe);
  const tree = camId ? documentMirror().tree(camId) : undefined;
  const animated = CAMERA_NAV_TRACKS.some((t) => trackRefIn(tree, t)?.info.animated === true);
  const text = cameraNavBadgeText({
    mode,
    cameraName: camera ? camera.name : null,
    keyframing: camera !== null && (autoKey || animated),
    viewLabel: cameraViewLabel(mode, comp),
  });
  if (!text) return null;
  return (
    <div className={styles.badge} role="status" data-camera-nav-badge="">
      {text}
    </div>
  );
}

export function CameraNavBadge(): JSX.Element | null {
  const toolArmed = useGuidesStore((s) => s.cameraTool !== 'none');
  const mode = useGuidesStore((s) => s.camera3dMode);
  const alt = useAltHeld();
  if (!toolArmed && !alt) return null;
  return <Badge mode={mode} />;
}

export default CameraNavBadge;
