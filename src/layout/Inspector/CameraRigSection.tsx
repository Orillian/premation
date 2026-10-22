/**
 * Camera Rig — the plain sliders of a camera rig (camera program R2): shown
 * when the selection is a rigged camera or any null of its rig, so the shot
 * can be operated from whichever of them the user clicked.
 *
 *   Truck · Pedestal · Dolly · Boom · Swing · Arm · Pan · Tilt
 *
 * (only the ones the rig kind has — `RIG_CONTROLS`). Each row is an ordinary
 * keyframable property row on the null (or the camera) it drives, so the
 * stopwatch, Auto-Keyframe and the timeline all see a plain Position /
 * Rotation track; the rig is nothing but named nulls (cameraRig.ts). Arm is a
 * LENGTH: the arm null's position scaled along its own direction, keyed on
 * its X / Y / Z together.
 */

import { t } from '@core/i18n';
import { ValueField } from '@components/ValueField';
import { useMirrorLayersShapeWatch, useMirrorTrackWatch } from '@hooks/useMirror';
import { documentMirror } from '@stores/documentMirror';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { edit } from '@core/engine/uiEdits';
import { isTrackAnimated, readTrack } from '@core/mirror/selection';
import { trackValueCommands } from '@core/workspace/toolEdits';
import { RIG_CONTROL_ORDER, RIG_CONTROLS, armValues, rigControlLabel, rigOf, type RigControl, type RigControlTarget, type RigInfo } from '@core/scene/cameraRig';
import { AnimToggle } from './AnimToggle';
import { KeyframeRow } from './KeyframeRow';
import { stopwatchCommands } from './inspectorEdits';
import { useEngineEdit } from './useEngineEdit';
import styles from './TransformSection.module.css';

/** Whether `nodeId` is part of a camera rig (the section's `appliesTo`). */
export function hasCameraRig(nodeId: string): boolean {
  return rigOf(nodeId) !== null;
}

const ARM_TRACKS = ['x', 'y', 'z'] as const;

function RigTrackRow({ nodeId, control, target }: { nodeId: string; control: RigControl; target: RigControlTarget }): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  useMirrorTrackWatch([nodeId], [target.track]);
  const value = readTrack(documentMirror(), nodeId, target.track, time) ?? 0;
  return (
    <div title={target.hint}>
      <KeyframeRow
        nodeId={nodeId}
        prop={target.track}
        label={rigControlLabel(control)}
        value={value}
        unit={target.unit}
        precision={target.unit === '°' ? 1 : 0}
        // Every rig member is a layer of a composition, so the row always takes the engine route.
        onStatic={() => undefined}
      />
    </div>
  );
}

/** Arm: the arm null's distance from its parent, scaled along its own direction. */
function RigArmRow({ nodeId, target }: { nodeId: string; target: RigControlTarget }): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);
  useMirrorTrackWatch([nodeId], [...ARM_TRACKS]);
  const m = documentMirror();
  const at = (track: string): number => readTrack(m, nodeId, track, time) ?? 0;
  const current = { x: at('x'), y: at('y'), z: at('z') };
  const length = Math.hypot(current.x, current.y, current.z);
  const animated = ARM_TRACKS.some((track) => isTrackAnimated(m, nodeId, track));
  const e = useEngineEdit();
  return (
    <div className={styles.popoverRow} title={target.hint}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
        <AnimToggle
          nodeId={nodeId}
          tracks={ARM_TRACKS}
          label={t('inspector.cameraRig.arm', 'Arm')}
          animated={animated}
          values={() => [current.x, current.y, current.z]}
          onToggle={() => { void edit(animated ? 'Remove Arm animation' : 'Animate Arm', stopwatchCommands([nodeId], [...ARM_TRACKS], time)); }}
        />
        <span className={styles.popoverLabel}>{t('inspector.cameraRig.arm', 'Arm')}</span>
      </div>
      <ValueField
        value={Math.round(length)}
        unit="px"
        min={0}
        onChange={(v) => {
          const cmds = trackValueCommands([{ nodeId, values: armValues(current, Number(v)) }], { seconds: time, autoKeyframe });
          if (cmds) e.send('Set Arm', cmds);
        }}
        {...e.scrub('Set Arm')}
        aria-label={t('inspector.cameraRig.arm', 'Arm')}
      />
    </div>
  );
}

function targetLayer(rig: RigInfo, target: RigControlTarget): string | null {
  return target.null === 'camera' ? rig.camera : rig.nulls[target.null] ?? null;
}

export function CameraRigSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  // A rename, reparent or deletion re-reads the rig; a value change does not.
  const probe = rigOf(nodeId);
  useMirrorLayersShapeWatch(probe ? [...Object.values(probe.nulls), ...(probe.camera ? [probe.camera] : [])] : [nodeId]);
  const rig = rigOf(nodeId);
  if (!rig) return null;
  const controls = RIG_CONTROLS[rig.kind];
  return (
    <div className={styles.section}>
      <div className={styles.inlineRows}>
        {RIG_CONTROL_ORDER.map((control) => {
          const target = controls[control];
          if (!target) return null;
          const layer = targetLayer(rig, target);
          if (!layer) return null;
          return target.track === 'arm'
            ? <RigArmRow key={control} nodeId={layer} target={target} />
            : <RigTrackRow key={control} nodeId={layer} control={control} target={target} />;
        })}
      </div>
    </div>
  );
}

export default CameraRigSection;
