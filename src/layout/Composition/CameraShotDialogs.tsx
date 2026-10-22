/**
 * The camera program's shot-making dialogs and the commands that open them
 * (R3a Follow Path…, R4 Fly to Selected Layers…). The edits themselves are
 * core (`cameraFollowPath.ts`, `cameraFlyTo.ts`); these collect the timing,
 * in seconds, with the defaults the program settled:
 *
 *   Follow Path   Start · Duration — the work area when one is set, else the
 *                 whole composition (AE's paste-path spans the layer's range)
 *   Fly to        Travel · Hold — 1.0 s each, from the playhead
 *
 * A command runs only with what it needs selected (a camera, and a path layer
 * / the layers to visit); otherwise it greys out in the menu.
 */

import { useState } from 'react';
import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { DialogFooter, useDialogPrimaryAction } from '@components/Modal';
import { openModal } from '@stores/modalStore';
import { useUIStore } from '@stores/uiStore';
import { documentMirror } from '@stores/documentMirror';
import { getTime } from '@stores/playbackClockStore';
import { activeCompIdNow } from '@hooks/useMirror';
import { settingsDurationSeconds } from '@core/mirror/compFacts';
import { activeWorkAreaSeconds } from '@core/timeline/workAreaEdits';
import { commandCamera, subjectLayers } from '@core/scene/cameraCommands';
import { followPathEdit } from '@core/scene/cameraFollowPath';
import { FLY_TO_DEFAULTS, flyToLayersEdit } from '@core/scene/cameraFlyTo';
import styles from './PrecomposeDialog.module.css';
import { t } from '@core/i18n';

function notify(message: string, level: 'info' | 'success' | 'warning' = 'info'): void {
  useUIStore.getState().notify({ level, message, durationMs: 4000 });
}

const nameOf = (id: string): string => documentMirror().layer(id)?.name ?? t('composition.cameraShot.theLayer', 'the layer');

/** The range Follow Path spans by default: the work area, else the whole composition. */
export function followPathRange(): { start: number; end: number } {
  const wa = activeWorkAreaSeconds();
  if (wa) return wa;
  const comp = activeCompIdNow();
  const s = comp ? documentMirror().comp(comp)?.settings : undefined;
  return { start: 0, end: s ? settingsDurationSeconds(s) : 10 };
}

/** A seconds field's text as a number (null: not one). */
function seconds(text: string): number | null {
  const n = Number(text);
  return text.trim() !== '' && Number.isFinite(n) ? n : null;
}

export function FollowPathDialog({ camera, pathLayer, close }: { camera: string; pathLayer: string; close: () => void }): JSX.Element {
  const range = followPathRange();
  const [startText, setStartText] = useState(String(Math.round(range.start * 100) / 100));
  const [durationText, setDurationText] = useState(String(Math.round((range.end - range.start) * 100) / 100));
  const start = seconds(startText);
  const duration = seconds(durationText);
  const valid = start !== null && start >= 0 && duration !== null && duration > 0;

  const submit = (): void => {
    if (!valid) return;
    close();
    void followPathEdit(camera, pathLayer, start, start + duration).then((r) => {
      notify(r.ok ? t('composition.cameraShot.followed', '{camera} follows {path} — {keys} keys over {duration} s', { camera: nameOf(camera), path: nameOf(pathLayer), keys: r.keys, duration }) : r.reason, r.ok ? 'success' : 'warning');
    });
  };
  useDialogPrimaryAction(submit);

  return (
    <div className={styles.root}>
      <label className={styles.field}>
        <span className={styles.label}>{t('composition.cameraShot.start', 'Start (seconds)')}</span>
        <Input type="number" min={0} step={0.1} value={startText} onChange={(e) => setStartText(e.target.value)} aria-label={t('composition.cameraShot.startAria', 'Start')} autoFocus />
      </label>
      <label className={styles.field}>
        <span className={styles.label} title={t('composition.cameraShot.durationHint', "The camera arrives at the path's last point this long after the start; the points between move at a constant speed (roving keys)")}>
          {t('composition.cameraShot.duration', 'Duration (seconds)')}
        </span>
        <Input type="number" min={0.1} step={0.1} value={durationText} onChange={(e) => setDurationText(e.target.value)} aria-label={t('composition.cameraShot.durationAria', 'Duration')} />
      </label>
      <DialogFooter
        secondary={<Button variant="secondary" size="md" onClick={close}>{t('composition.dialog.cancel', 'Cancel')}</Button>}
        primary={<Button variant="primary" size="md" onClick={submit} disabled={!valid}>{t('composition.cameraShot.followPath', 'Follow Path')}</Button>}
      />
    </div>
  );
}

export function FlyToDialog({ camera, layers, close }: { camera: string; layers: readonly string[]; close: () => void }): JSX.Element {
  const [travelText, setTravelText] = useState(String(FLY_TO_DEFAULTS.travel));
  const [holdText, setHoldText] = useState(String(FLY_TO_DEFAULTS.hold));
  const travel = seconds(travelText);
  const hold = seconds(holdText);
  const valid = travel !== null && travel > 0 && hold !== null && hold >= 0;

  const submit = (): void => {
    if (!valid) return;
    close();
    void flyToLayersEdit(camera, layers, getTime(), { travel, hold }).then((r) => {
      notify(r.ok ? (layers.length === 1
        ? t('composition.cameraShot.visitedOne', '{camera} visits {n} layer — the move ends at {end} s', { camera: nameOf(camera), n: layers.length, end: Math.round(r.end * 100) / 100 })
        : t('composition.cameraShot.visitedOther', '{camera} visits {n} layers — the move ends at {end} s', { camera: nameOf(camera), n: layers.length, end: Math.round(r.end * 100) / 100 })) : r.reason, r.ok ? 'success' : 'warning');
    });
  };
  useDialogPrimaryAction(submit);

  return (
    <div className={styles.root}>
      <label className={styles.field}>
        <span className={styles.label} title={t('composition.cameraShot.travelHint', 'Seconds from one framing to the next, eased')}>{t('composition.cameraShot.travel', 'Travel (seconds)')}</span>
        <Input type="number" min={0.1} step={0.1} value={travelText} onChange={(e) => setTravelText(e.target.value)} aria-label={t('composition.cameraShot.travelAria', 'Travel')} autoFocus />
      </label>
      <label className={styles.field}>
        <span className={styles.label} title={t('composition.cameraShot.holdHint', 'Seconds the camera rests on each layer')}>{t('composition.cameraShot.hold', 'Hold (seconds)')}</span>
        <Input type="number" min={0} step={0.1} value={holdText} onChange={(e) => setHoldText(e.target.value)} aria-label={t('composition.cameraShot.holdAria', 'Hold')} />
      </label>
      <DialogFooter
        secondary={<Button variant="secondary" size="md" onClick={close}>{t('composition.dialog.cancel', 'Cancel')}</Button>}
        primary={<Button variant="primary" size="md" onClick={submit} disabled={!valid}>{t('composition.cameraShot.fly', 'Fly')}</Button>}
      />
    </div>
  );
}

/** The path layer of the selection: the first selected layer that is not a camera or light. */
function pathLayerNow(): string | null {
  return subjectLayers()[0] ?? null;
}

export function openFollowPathDialog(): void {
  const camera = commandCamera();
  const pathLayer = pathLayerNow();
  if (!camera || !pathLayer) {
    notify(t('composition.cameraShot.needFollowSelection', 'Select a camera and a shape or masked layer whose path it should follow.'));
    return;
  }
  openModal({ id: 'camera-follow-path', title: t('composition.cameraShot.followPath', 'Follow Path'), render: (close) => <FollowPathDialog camera={camera} pathLayer={pathLayer} close={close} /> });
}

export function openFlyToDialog(): void {
  const camera = commandCamera();
  const layers = subjectLayers();
  if (!camera || layers.length === 0) {
    notify(t('composition.cameraShot.needFlySelection', 'Select a camera and the layers it should fly to, in order.'));
    return;
  }
  openModal({ id: 'camera-fly-to', title: t('composition.cameraShot.flyToTitle', 'Fly to Selected Layers'), render: (close) => <FlyToDialog camera={camera} layers={layers} close={close} /> });
}

/** Layer ▸ Camera ▸ Follow Path… / Fly to Selected Layers… */
export function buildCameraShotCommands(): ReadonlyArray<Command> {
  return [
    {
      id: asCommandId('camera.followPath'),
      label: t('composition.cameraShot.followPathCommand', 'Follow Path…'),
      description: t('composition.cameraShot.followPathDescription', 'The selected path (shape or mask) becomes the camera\'s Position keys — roving, at a constant speed'),
      icon: 'camera',
      enabled: () => commandCamera() !== null && pathLayerNow() !== null,
      execute: () => { openFollowPathDialog(); },
    },
    {
      id: asCommandId('camera.flyToLayers'),
      label: t('composition.cameraShot.flyToCommand', 'Fly to Selected Layers…'),
      description: t('composition.cameraShot.flyToDescription', 'Keyframe the camera to frame each selected layer in turn, from the playhead'),
      icon: 'camera',
      enabled: () => commandCamera() !== null && subjectLayers().length > 0,
      execute: () => { openFlyToDialog(); },
    },
  ];
}
