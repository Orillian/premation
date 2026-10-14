/**
 * The "Shot" header of Camera Options (camera program U3, 2026-10-14): the
 * things a user reaches for when MAKING a shot, at the top of the section,
 * one click each —
 *
 *   [No 3D layers — the camera moves nothing yet.]  [Make All 3D]   (when it applies)
 *   Lens        50mm — Standard ▾
 *   [Push In] [Pull Out] [Orbit Sweep] [Drift Parallax] [Dolly Zoom] [Handheld]
 *   [Focus on Layer] [Distribute in Z] [Create Orbit Null] [Add Rig ▾] [Fly to Layers]
 *
 * Before this the good tools were scattered: the lens list behind the ≡ menu,
 * the camera moves in the Animation Presets panel, Create Orbit Null and
 * Distribute in Z in the Layer ▸ Camera menu, and the one warning that
 * explains a camera doing nothing at the BOTTOM of the section under a
 * closed twirl. The verbs below are the same engine edits those places run
 * (`applyPreset`, `createOrbitNullEdit`, `distributeLayersInZ`), so each
 * click is ONE undo entry.
 *
 * The lens picker is the app `Dropdown`: the shared list (lensPresets.ts),
 * the lens in force ticked, and the trigger reading "Custom · 42.3 mm" when
 * the Zoom matches no preset — a picker that silently showed the nearest
 * preset would claim a lens the camera does not have.
 */

import type { ReactNode } from 'react';
import { Button } from '@components/Button';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { Icon } from '@components/Icon';
import { LENS_PRESETS, focalPxForMm, lensPresetForFocalPx, mmForFocalPx } from '@core/scene/lensPresets';
import { createOrbitNullEdit, distributeLayersInZ } from '@core/scene/cameraCommands';
import { CAMERA_RIG_KINDS, addCameraRigEdit } from '@core/scene/cameraRig';
import { applyAnimationPresetEdit } from '@layout/Menu/appEdits';
import { openFlyToDialog } from '@layout/Composition/CameraShotDialogs';
import { getTime } from '@stores/playbackClockStore';
import { useUIStore } from '@stores/uiStore';
import { useFocusPickStore } from '@layout/Workspace/focusPickStore';
import styles from './TransformSection.module.css';
import shot from './CameraShotHeader.module.css';

/** The camera moves offered as one-click buttons: the engine preset name, and the button's label. */
export const SHOT_PRESETS: ReadonlyArray<{ preset: string; label: string }> = [
  { preset: 'Push In', label: 'Push In' },
  { preset: 'Pull Out', label: 'Pull Out' },
  { preset: 'Orbit Sweep', label: 'Orbit Sweep' },
  { preset: 'Drift Parallax', label: 'Drift Parallax' },
  { preset: 'Dolly Zoom (Vertigo)', label: 'Dolly Zoom' },
  { preset: 'Handheld', label: 'Handheld' },
];

function notify(message: string, level: 'info' | 'success' | 'warning' = 'info'): void {
  useUIStore.getState().notify({ level, message, durationMs: 4000 });
}

/** The lens rows of a picker: the shared list, the one in force ticked; a pick sets Zoom (one entry). */
export function lensItems(compWidth: number, focalPx: number, setFocal: (px: number) => void): DropdownItem[] {
  const active = lensPresetForFocalPx(compWidth, focalPx);
  return LENS_PRESETS.map((p): DropdownItem => ({
    type: 'item',
    id: `lens-preset-${p.mm}`,
    label: p.label,
    ...(p === active ? { icon: 'check' as const } : {}),
    onSelect: () => setFocal(Math.round(focalPxForMm(compWidth, p.mm))),
  }));
}

/** What the lens trigger reads: the preset's label, or "Custom · <mm> mm". */
export function lensTriggerLabel(compWidth: number, focalPx: number): string {
  const active = lensPresetForFocalPx(compWidth, focalPx);
  return active ? active.label : `Custom · ${mmForFocalPx(compWidth, focalPx).toFixed(1)} mm`;
}

export interface CameraShotHeaderProps {
  nodeId: string;
  compWidth: number;
  /** The camera's Zoom (comp px), resolved. */
  focal: number;
  setFocal: (px: number) => void;
  /** The comp has content layers and none of them is 3D: the camera moves nothing. */
  no3D: boolean;
  makeAll3D: () => void;
  /** Extra verbs from rows that own them (pick focus, rigs, fly-to) — drawn after the built-in ones. */
  actions?: ReactNode;
}

export function CameraShotHeader({ nodeId, compWidth, focal, setFocal, no3D, makeAll3D, actions }: CameraShotHeaderProps): JSX.Element {
  const label = lensTriggerLabel(compWidth, focal);
  const picking = useFocusPickStore((s) => s.camera === nodeId);
  return (
    <>
      {no3D && (
        <>
          <p className={styles.helpWarning} role="note">No 3D layers — the camera moves nothing yet.</p>
          <div className={styles.actionRow}>
            <Button size="sm" variant="secondary" onClick={makeAll3D} title="Turn on the 3D switch of every layer in this composition that can be 3D">
              Make All 3D
            </Button>
          </div>
        </>
      )}
      <div className={styles.popoverRow}>
        <span className={styles.popoverLabel}>Lens</span>
        <Dropdown
          placement="bottom-end"
          trigger={
            <button type="button" className={shot.trigger} aria-label="Lens" title="Pick a lens: sets Zoom (and the Angle of View with it)">
              <span className={shot.triggerText}>{label}</span>
              <Icon name="chevron-down" size="sm" />
            </button>
          }
          items={() => lensItems(compWidth, focal, setFocal)}
        />
      </div>
      <div className={shot.grid} role="group" aria-label="Camera moves" title="One-click camera moves from the playhead, as ordinary keyframes (Handheld sets the camera's Shake)">
        {SHOT_PRESETS.map((p) => (
          <button
            key={p.preset}
            type="button"
            className={styles.presetChip}
            onClick={() => {
              void applyAnimationPresetEdit([nodeId], p.preset, getTime()).then((ok) => {
                if (!ok) notify(`Could not apply ${p.label}`, 'warning');
              });
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className={shot.actions} role="group" aria-label="Camera actions">
        <Button
          size="sm"
          variant="secondary"
          aria-pressed={picking}
          title={picking ? 'Click a layer in the viewer to focus on it (Esc cancels)' : 'Put the focal plane on a layer: click this, then the layer in the viewer'}
          onClick={() => {
            const s = useFocusPickStore.getState();
            if (picking) s.cancel();
            else s.arm(nodeId);
          }}
        >
          Focus on Layer
        </Button>
        <Button
          size="sm"
          variant="secondary"
          title="Spread the comp's layers (or the selected ones) apart in depth so a camera move has parallax — sizes compensated so the framing does not change"
          onClick={() => {
            void distributeLayersInZ(getTime()).then((r) => {
              notify(
                r ? `Spread ${r.count} layers across ${r.span} px of depth — move the camera to see the parallax` : 'Need at least two layers to distribute in Z',
                r ? 'success' : 'warning',
              );
            });
          }}
        >
          Distribute in Z
        </Button>
        <Button
          size="sm"
          variant="secondary"
          title="A 3D null at the camera's point of interest, with the camera parented to it — rotate the null to orbit the shot"
          onClick={() => {
            void createOrbitNullEdit(nodeId, getTime()).then((id) => {
              notify(id ? 'Created an orbit null — rotate it to orbit the camera' : 'Could not create the orbit null', id ? 'success' : 'warning');
            });
          }}
        >
          Create Orbit Null
        </Button>
        <Dropdown
          placement="bottom-start"
          trigger={
            <Button size="sm" variant="secondary" title="Build a crane, dolly or orbit rig of 3D nulls above this camera — then operate it from Camera Rig">
              Add Rig
            </Button>
          }
          items={() => CAMERA_RIG_KINDS.map(({ kind, label, description }): DropdownItem => ({
            type: 'item',
            id: `rig-${kind}`,
            label: <span title={description}>{label}</span>,
            onSelect: () => {
              void addCameraRigEdit(nodeId, kind, getTime()).then((ids) => {
                notify(ids ? `${label} rig added — operate it from Camera Rig` : `Could not add the ${label.toLowerCase()} rig`, ids ? 'success' : 'warning');
              });
            },
          }))}
        />
        <Button
          size="sm"
          variant="secondary"
          title="Keyframe the camera to frame each selected layer in turn, from the playhead (select the camera, then the layers in order)"
          onClick={openFlyToDialog}
        >
          Fly to Layers
        </Button>
        {actions}
      </div>
    </>
  );
}

export default CameraShotHeader;
