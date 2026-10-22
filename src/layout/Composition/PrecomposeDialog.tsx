/**
 * Pre-compose dialog — After Effects' Layer ▸ Pre-compose (Ctrl+Shift+C).
 *
 * The same four decisions AE asks for, in the same order: the new comp's name,
 * Leave vs Move all attributes, trim the new comp to the layers' span, and
 * whether to open it. "Leave" greys out with its reason when the selection
 * cannot be split that way (more than one layer, a text or shape layer), which
 * is how AE presents it. Choices are remembered for the session, as AE does.
 */

import { useEffect, useState } from 'react';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { Checkbox } from '@components/Checkbox';
import { DialogFooter, useDialogPrimaryAction } from '@components/Modal';
import { openModal } from '@stores/modalStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow, useActiveMirrorComp } from '@hooks/useMirror';
import { defaultPrecompNameIn } from '@core/mirror/compNames';
import { engine } from '@core/engine/engineInstance';
import type { PrecomposeMode } from '@core/composition/precompose';
import { mirrorPrecomposeTargets } from '@core/mirror/compLayers';
import { precomposeEdit } from './compositionEdits';
import { cn } from '@utils/cn';
import styles from './PrecomposeDialog.module.css';
import { t } from '@core/i18n';

/** The last choices, reused next time within the session. */
const remembered: { mode: PrecomposeMode; adjustDuration: boolean; openNew: boolean } = {
  mode: 'move',
  adjustDuration: false,
  openNew: true,
};

function PrecomposeDialog({ ids, close }: { ids: string[]; close: () => void }): JSX.Element {
  // B4: names from the document mirror.
  const hostName = useActiveMirrorComp()?.settings.name ?? t('composition.precompose.thisComposition', 'this composition');
  // B4: "Leave all attributes" availability is the engine's own refusal, asked as a dry run
  // (`checkPrecompose`); `undefined` while it is being asked (the option stays off until then).
  const [leaveBlocked, setLeaveBlocked] = useState<string | null | undefined>(undefined);
  const [name, setName] = useState(() => defaultPrecompNameIn(documentMirror()));
  const [mode, setMode] = useState<PrecomposeMode>('move');
  useEffect(() => {
    let live = true;
    void engine().query({ type: 'checkPrecompose', comp: activeCompIdNow() ?? '', layers: [...ids] }).then((r) => {
      if (!live) return;
      const reason = r.ok ? r.value.leaveAttributesReason || null : t('composition.precompose.leaveSingleOnly', 'Only available when a single layer is selected.');
      setLeaveBlocked(reason);
      if (remembered.mode === 'leave' && !reason) setMode('leave');
    });
    return () => { live = false; };
  }, [ids]);
  const [adjustDuration, setAdjustDuration] = useState(remembered.adjustDuration);
  const [openNew, setOpenNew] = useState(remembered.openNew);
  const [busy, setBusy] = useState(false);

  const layerName = ids.length === 1 ? documentMirror().layer(ids[0]!)?.name ?? t('composition.precompose.theLayer', 'the layer') : '';
  const count = ids.length;

  const submit = (): void => {
    if (busy) return;
    setBusy(true);
    Object.assign(remembered, { mode, adjustDuration, openNew });
    const notify = useUIStore.getState().notify;
    // One engine entry (`precompose`): undo restores the layers exactly. The
    // selection and "Open New Composition" are the dialog's (editor state).
    precomposeEdit(ids, {
      name: name.trim() || defaultPrecompNameIn(documentMirror()),
      mode,
      adjustDuration: mode === 'move' && adjustDuration,
      openNew,
    })
      .then((result) => {
        if ('error' in result) notify({ level: 'warning', message: t('composition.precompose.error', 'Pre-compose: {error}', { error: result.error }), durationMs: 5000 });
      })
      .catch((err: unknown) => {
        notify({ level: 'error', message: t('composition.precompose.failed', 'Pre-compose failed: {error}', { error: err instanceof Error ? err.message : String(err) }), durationMs: 8000 });
      })
      .finally(close);
  };
  useDialogPrimaryAction(submit);

  return (
    <div className={styles.root}>
      <label className={styles.field}>
        <span className={styles.label}>{t('composition.precompose.name', 'New composition name')}</span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label={t('composition.precompose.name', 'New composition name')}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
        />
      </label>

      <fieldset className={styles.modes}>
        <legend className={styles.srOnly}>{t('composition.precompose.attributes', 'Attributes')}</legend>
        <label className={cn(styles.option, leaveBlocked !== null && styles.optionDisabled)}>
          <input
            type="radio"
            name="precompose-mode"
            className={styles.radio}
            checked={mode === 'leave'}
            disabled={leaveBlocked !== null}
            onChange={() => setMode('leave')}
          />
          <span className={styles.optionText}>
            <span className={styles.optionTitle}>{t('composition.precompose.leave', 'Leave all attributes in “{host}”', { host: hostName })}</span>
            <span className={styles.optionHint}>
              {leaveBlocked
                ?? t('composition.precompose.leaveHint', 'Only the content of “{layer}” moves into the new composition, which is sized to it. Its transform, effects, masks and keyframes stay on the layer here.', { layer: layerName })}
            </span>
          </span>
        </label>
        <label className={styles.option}>
          <input
            type="radio"
            name="precompose-mode"
            className={styles.radio}
            checked={mode === 'move'}
            onChange={() => setMode('move')}
          />
          <span className={styles.optionText}>
            <span className={styles.optionTitle}>{t('composition.precompose.move', 'Move all attributes into the new composition')}</span>
            <span className={styles.optionHint}>
              {count === 1
                ? t('composition.precompose.moveHintOne', 'The selected layer moves into the new composition with everything on them. It is the same size as “{host}”, so nothing moves on screen.', { host: hostName })
                : t('composition.precompose.moveHintOther', 'The {n} selected layers move into the new composition with everything on them. It is the same size as “{host}”, so nothing moves on screen.', { n: count, host: hostName })}
            </span>
          </span>
        </label>
      </fieldset>

      <div className={styles.checks}>
        <Checkbox
          checked={mode === 'move' && adjustDuration}
          disabled={mode !== 'move'}
          onChange={(e) => setAdjustDuration(e.target.checked)}
          label={t('composition.precompose.adjustDuration', 'Adjust composition duration to the time span of the selected layers')}
        />
        <Checkbox
          checked={openNew}
          onChange={(e) => setOpenNew(e.target.checked)}
          label={t('composition.precompose.openNew', 'Open New Composition')}
        />
      </div>

      <DialogFooter
        secondary={
          <Button variant="secondary" size="md" onClick={close}>
            {t('composition.dialog.cancel', 'Cancel')}
          </Button>
        }
        primary={
          <Button variant="primary" size="md" onClick={submit} disabled={busy}>
            {t('composition.dialog.ok', 'OK')}
          </Button>
        }
      />
    </div>
  );
}

/** Open Pre-compose for `ids` (default: the selection). */
export function openPrecomposeDialog(ids: ReadonlyArray<string> = useSelectionStore.getState().ids): void {
  // A READ (which selected layers the pre-compose moves); the ratchet's verb
  // pattern flags `precompose…` names — see the B3 report's false positives.
  const targets = mirrorPrecomposeTargets(documentMirror(), ids, activeCompIdNow());
  if (targets.length === 0) {
    useUIStore.getState().notify({ level: 'info', message: t('composition.precompose.selectFirst', 'Select the layers to pre-compose first.'), durationMs: 4000 });
    return;
  }
  openModal({
    id: 'precompose',
    title: t('composition.precompose.title', 'Pre-compose'),
    render: (close) => <PrecomposeDialog ids={targets} close={close} />,
  });
}
