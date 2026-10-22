/**
 * Noise Gate — the dialog.
 *
 * Set a threshold, and everything below it is pulled down. The result is
 * ordinary level keyframes you can see and drag afterwards; see
 * `core/audio/audioGate.ts` for why it bakes rather than running a gate node at
 * playback, and why that turns out to be an advantage.
 *
 * Three actions, matching the ducking dialog and for the same reason: a baked
 * curve has three lifecycle moments, and hiding two of them is how a bake
 * becomes untouchable. **Apply** writes it, **Re-gate** runs it again after the
 * take changed, **Remove** takes the track and the record away. The last two
 * appear only when there is something to redo or remove.
 */

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@components/Button';
import { Slider } from '@components/Slider';
import { t } from '@core/i18n';
import { openModal } from '@stores/modalStore';
import { useUIStore } from '@stores/uiStore';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorProperty } from '@hooks/useMirror';
import { gateOf } from '@core/mirror/audio';
import { setAudioToolOpener } from './audioCommands';
import { DEFAULT_GATE, type GateParams } from '@core/audio/audioGate';
import { removeGateEdit } from './audioEdits';
import { previewEngineJob, runEngineJob } from '@core/engine/engineJobs';
import styles from './AudioToolDialog.module.css';

interface Props {
  nodeId: string;
  onDone: () => void;
}

interface Preview {
  keyframes: number;
  /** Fraction of the range the gate holds closed, 0..1. */
  closedFraction: number;
}

export function GateDialog({ nodeId, onDone }: Props): JSX.Element {
  // The remembered gate (`audio/gate`), from the document mirror (B4).
  const gateInfo = useMirrorProperty(nodeId, 'audio/gate');
  const stored = useMemo(() => (gateInfo ? gateOf(documentMirror(), nodeId) : null), [gateInfo, nodeId]);

  const [params, setParams] = useState<GateParams>(() => (stored ? { ...stored } : { ...DEFAULT_GATE }));
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [analysing, setAnalysing] = useState(false);

  const set = <K extends keyof GateParams>(k: K, v: GateParams[K]): void =>
    setParams((p) => ({ ...p, [k]: v }));

  /*
    Preview, debounced: every slider drag would otherwise start a decode and an
    envelope pass over the whole work area on each pointer move. The numbers
    are the engine's audioGate job summary (apply: false) — the same pass the
    bake runs — so the count shown is the count written.
  */
  const key = JSON.stringify(params);
  useEffect(() => {
    let alive = true;
    setAnalysing(true);
    const timer = setTimeout(() => {
      void (async () => {
        const viaEngine = await previewEngineJob<{ keyframes: number; closedFraction?: number }>({
          kind: 'audioGate', value: { layer: nodeId, params: key },
        });
        if (alive) {
          setPreview(viaEngine && viaEngine.status === 'done' && viaEngine.result
            ? { keyframes: viaEngine.result.keyframes, closedFraction: viaEngine.result.closedFraction ?? 0 }
            : null);
        }
      })()
        .catch(() => { if (alive) setPreview(null); })
        .finally(() => { if (alive) setAnalysing(false); });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [nodeId, key]);

  const notify = (message: string, level: 'info' | 'warning' = 'info'): void => {
    useUIStore.getState().notify({ level, message, durationMs: 5000 });
  };

  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      const viaEngine = await runEngineJob<{ keyframes: number }>({ kind: 'audioGate', value: { layer: nodeId, params: JSON.stringify(params) } });
      if (!viaEngine) notify(t('inspector.gate.unsupported', 'The noise gate runs in the engine, and this engine does not run it.'), 'warning');
      else if (viaEngine.status === 'done') notify(t('inspector.gate.done', 'Gated — {n} level keyframes written.', { n: viaEngine.result?.keyframes ?? 0 }));
      else if (viaEngine.status === 'failed') notify(viaEngine.error?.message ?? t('inspector.gate.failed', 'The gate could not be written.'), 'warning');
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const drop = async (): Promise<void> => {
    setBusy(true);
    try {
      if (await removeGateEdit(nodeId)) notify(t('inspector.gate.removed', 'Noise gate removed.'));
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.body}>
      <p className={styles.intro}>
        {t('inspector.gate.intro', 'Pull this layer down wherever it is quieter than the threshold — room tone between phrases, hiss under a take. Written as level keyframes, so every one of them can be reshaped afterwards.')}
      </p>

      <div className={styles.row}>
        <span className={styles.label}>{t('inspector.gate.threshold', 'Threshold')}</span>
        <div className={styles.control}>
          <Slider
            value={params.thresholdDb}
            min={-80}
            max={0}
            step={1}
            onChange={(v) => set('thresholdDb', v)}
            aria-label={t('inspector.gate.thresholdAria', 'Gate threshold')}
          />
          <span className={styles.value}>{`${params.thresholdDb} dB`}</span>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>{t('inspector.gate.range', 'Range')}</span>
        <div className={styles.control}>
          <Slider
            value={params.rangeDb}
            min={-60}
            max={0}
            step={1}
            onChange={(v) => set('rangeDb', v)}
            aria-label={t('inspector.gate.rangeAria', 'Gate range')}
          />
          <span className={styles.value}>{params.rangeDb <= -60 ? t('inspector.gate.silence', 'Silence') : `${params.rangeDb} dB`}</span>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>{t('inspector.gate.attack', 'Attack')}</span>
        <div className={styles.control}>
          <Slider
            value={params.attackMs}
            min={0}
            max={200}
            step={1}
            onChange={(v) => set('attackMs', v)}
            aria-label={t('inspector.gate.attackAria', 'Gate attack')}
          />
          <span className={styles.value}>{`${params.attackMs} ms`}</span>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>{t('inspector.gate.hold', 'Hold')}</span>
        <div className={styles.control}>
          <Slider
            value={params.holdMs}
            min={0}
            max={1000}
            step={10}
            onChange={(v) => set('holdMs', v)}
            aria-label={t('inspector.gate.holdAria', 'Gate hold')}
          />
          <span className={styles.value}>{`${params.holdMs} ms`}</span>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>{t('inspector.gate.release', 'Release')}</span>
        <div className={styles.control}>
          <Slider
            value={params.releaseMs}
            min={5}
            max={2000}
            step={5}
            onChange={(v) => set('releaseMs', v)}
            aria-label={t('inspector.gate.releaseAria', 'Gate release')}
          />
          <span className={styles.value}>{`${params.releaseMs} ms`}</span>
        </div>
      </div>

      <p className={styles.readout}>
        {analysing
          ? t('inspector.gate.listening', 'Listening…')
          : preview
            ? t('inspector.gate.preview', '{n} keyframes · closed for {pct}% of the range', { n: preview.keyframes, pct: Math.round(preview.closedFraction * 100) })
            : t('inspector.gate.nothing', 'Nothing to analyse in this range.')}
      </p>
      {preview && preview.closedFraction > 0.9 && (
        <p className={styles.warn}>
          {t('inspector.gate.shutWarn', 'The gate is shut almost the whole time — the threshold is probably above the take itself. Try lowering it.')}
        </p>
      )}

      <div className={styles.actions}>
        <Button variant="ghost" onClick={onDone} disabled={busy}>{t('inspector.gate.cancel', 'Cancel')}</Button>
        {stored && (
          <Button variant="ghost" onClick={() => void drop()} disabled={busy}>{t('inspector.gate.remove', 'Remove')}</Button>
        )}
        <Button onClick={() => void run()} disabled={busy || !preview}>
          {stored ? t('inspector.gate.regate', 'Re-gate') : t('inspector.gate.apply', 'Apply')}
        </Button>
      </div>
    </div>
  );
}

/** Open the dialog for one layer. Registered below so the command can call it. */
export function openGateDialog(nodeId: string): void {
  openModal({
    title: t('inspector.gate.title', 'Noise gate'),
    size: 'sm',
    render: (close) => <GateDialog nodeId={nodeId} onDone={close} />,
  });
}

// Same contract the other two audio tools have: the dialog registers itself as
// it loads, so a command in `core/` never imports a React component.
setAudioToolOpener('gate', openGateDialog);

export default GateDialog;
