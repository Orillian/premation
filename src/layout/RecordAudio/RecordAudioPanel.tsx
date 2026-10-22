/**
 * Record Audio (Window ▸ Panels ▸ Record Audio, the palette, the Project
 * panel's Import ▾ menu): record a voice-over from a microphone, edit the
 * take, and add it to the project / the composition.
 *
 *   Input    device (remembered in prefs, never the project), input gain,
 *            echo cancellation / noise suppression / auto gain, a live meter
 *            with peak hold and a latched clip LED.
 *   Record   record / pause / stop, the clock, a 3-2-1 count-in, and "play
 *            the composition while recording" (the transport through the
 *            timeline API; the take starts at the playhead).
 *   Takes    rename, delete, audition. The originals are kept for the
 *            session; an edit renders a NEW WAV.
 *   Edit     trim, gain, normalize (peak / loudness), fades, high-pass,
 *            noise gate, Revert to Original — then Add to Composition (an
 *            audio layer at the take's start) or Add to Project.
 *
 * Capture is lossless PCM from an AudioWorklet at the context's rate, mono or
 * stereo as the device gives it (core/audio/recording). The meter and the
 * clock are written to the DOM from one rAF loop through refs: nothing here
 * renders per audio block or per frame.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Button } from '@components/Button';
import { Checkbox } from '@components/Checkbox';
import { Icon } from '@components/Icon';
import { IconButton } from '@components/IconButton';
import { customConfirm } from '@components/Modal/Dialogs';
import { ValueField } from '@components/ValueField';
import { listInputDevices, type InputDevice } from '@core/audio/recording/captureSession';
import { meterFraction, METER_FLOOR_DB } from '@core/audio/recording/meter';
import {
  INITIAL_RECORDER_STATE,
  inputOpen,
  recorderReducer,
  takeInProgress,
  type RecorderErrorKind,
} from '@core/audio/recording/recorderMachine';
import { formatTakeTime, nextTakeName } from '@core/audio/recording/takes';
import { t } from '@core/i18n';
import { usePremiumAccess, type PremiumAccess } from '@hooks/usePremiumAccess';
import { useRecordAudioPrefsStore, type RecordAudioPrefs } from '@stores/recordAudioPrefsStore';
import { useRecordAudioTakesStore, type TakeMeta } from '@stores/recordAudioTakesStore';
import { useUIStore } from '@stores/uiStore';
import { cn } from '@utils/cn';
import { RecordController, type FinishedTakeData, type RecordSettings } from './recordController';
import { addTakeToComposition, addTakeToProject, editedSpan, hasComposition, takeBlobForUse } from './takeInsertEdits';
import { TakeEditor } from './TakeEditor';
import styles from './RecordAudioPanel.module.css';

/**
 * The Pro gate, one line: flip to true and the panel asks for Premation
 * Cloud on the server edition (the local edition is never gated).
 */
export const RECORD_AUDIO_REQUIRES_PRO = false;

export function recordAudioAllowed(access: PremiumAccess, requiresPro = RECORD_AUDIO_REQUIRES_PRO): boolean {
  return !requiresPro || access === 'pro' || access === 'local';
}

let takeSeq = 0;

function settingsOf(p: RecordAudioPrefs): RecordSettings {
  return {
    deviceId: p.deviceId,
    echoCancellation: p.echoCancellation,
    noiseSuppression: p.noiseSuppression,
    autoGainControl: p.autoGainControl,
    inputGainDb: p.inputGainDb,
    countIn: p.countIn,
    playWhileRecording: p.playWhileRecording,
    format: p.format,
  };
}

function notify(level: 'info' | 'success' | 'warning' | 'error', message: string): void {
  useUIStore.getState().notify({ level, message, durationMs: level === 'error' || level === 'warning' ? 6000 : 3500 });
}

function errorText(kind: RecorderErrorKind, detail?: string): string {
  const platform = typeof window !== 'undefined' ? window.motionEditor?.platform : undefined;
  switch (kind) {
    case 'permission': return t('recordAudio.error.permission', 'Microphone access was refused. Allow it and try again.');
    case 'osDenied':
      return platform === 'darwin'
        ? t('recordAudio.error.osDeniedMac', 'macOS has the microphone turned off for Premation: System Settings ▸ Privacy & Security ▸ Microphone.')
        : platform === 'win32'
          ? t('recordAudio.error.osDeniedWin', 'Windows has the microphone turned off: Settings ▸ Privacy & security ▸ Microphone.')
          : t('recordAudio.error.osDenied', 'The system has the microphone turned off for this app.');
    case 'noDevice': return t('recordAudio.error.noDevice', 'No microphone found. Plug one in, or pick another input.');
    case 'busy': return t('recordAudio.error.busy', 'The input is in use by another app or could not start.');
    case 'deviceLost': return t('recordAudio.error.deviceLost', 'The input went away (unplugged?). What was recorded so far was kept.');
    case 'unsupported': return t('recordAudio.error.unsupported', 'Recording is not available in this build.');
    case 'tooLong': return t('recordAudio.error.tooLong', 'The take reached the longest a WAV file can hold, so it was stopped and kept.');
    case 'failed': return t('recordAudio.error.failed', 'Could not open the input: {detail}', { detail: detail ?? '' });
  }
}

export function RecordAudioPanel(): JSX.Element {
  const access = usePremiumAccess();
  if (!recordAudioAllowed(access)) {
    return (
      <div className={styles.root}>
        <p className={styles.note}>{t('recordAudio.locked', 'Recording audio is part of Premation Cloud.')}</p>
      </div>
    );
  }
  return <RecordAudioBody />;
}

/** The input meter + the take clock: one rAF loop writing through refs while the input is open. */
function useMeterLoop(
  controller: RecordController,
  active: boolean,
  channels: number,
  refs: {
    fill: Array<HTMLDivElement | null>;
    hold: Array<HTMLDivElement | null>;
    led: Array<HTMLButtonElement | null>;
    db: Array<HTMLSpanElement | null>;
    clock: HTMLSpanElement | null;
  },
): void {
  useEffect(() => {
    if (!active || typeof requestAnimationFrame === 'undefined') return;
    let raf = 0;
    const lastDb: number[] = Array.from({ length: channels }, () => NaN);
    let lastTenths = -1;
    const tick = (): void => {
      const m = controller.meter;
      for (let c = 0; c < channels; c++) {
        const ch = m.channels[c] ?? m.channels[0];
        if (!ch) continue;
        const f = meterFraction(ch.levelDb);
        const fill = refs.fill[c];
        // A style string per channel per frame: the meter is 1–2 bars, not a hot path.
        if (fill) fill.style.clipPath = `inset(0 ${((1 - f) * 100).toFixed(2)}% 0 0)`;
        const hold = refs.hold[c];
        if (hold) hold.style.left = `${(meterFraction(ch.holdDb) * 100).toFixed(2)}%`;
        const led = refs.led[c];
        if (led && led.classList.contains(styles.clipLedOn!) !== ch.clipped) led.classList.toggle(styles.clipLedOn!, ch.clipped);
        const rounded = Math.round(ch.holdDb);
        const db = refs.db[c];
        if (db && rounded !== lastDb[c]) {
          lastDb[c] = rounded;
          db.textContent = ch.holdDb <= METER_FLOOR_DB ? '-∞' : String(rounded);
        }
      }
      const tenths = Math.floor(controller.elapsedSec() * 10);
      if (refs.clock && tenths !== lastTenths) {
        lastTenths = tenths;
        refs.clock.textContent = formatTakeTime(tenths / 10);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [controller, active, channels, refs]);
}

function RecordAudioBody(): JSX.Element {
  const [state, dispatch] = useReducer(recorderReducer, INITIAL_RECORDER_STATE);
  const prefs = useRecordAudioPrefsStore();
  const takes = useRecordAudioTakesStore((s) => s.takes);
  const selectedId = useRecordAudioTakesStore((s) => s.selectedId);
  const [devices, setDevices] = useState<InputDevice[]>([]);
  const [input, setInput] = useState<RecordController['input']>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [auditionId, setAuditionId] = useState<string | null>(null);
  const audition = useRef<{ id: string; el: HTMLAudioElement; url: string } | null>(null);
  const pendingRecord = useRef(false);

  const controllerRef = useRef<RecordController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new RecordController({
      dispatch,
      settings: () => settingsOf(useRecordAudioPrefsStore.getState()),
      onTake: (d: FinishedTakeData) => {
        const store = useRecordAudioTakesStore.getState();
        store.add(
          {
            id: `take_${++takeSeq}`,
            name: nextTakeName(store.takes.map((tk) => tk.name), t('recordAudio.takeBase', 'Voice-over')),
            durationSec: d.durationSec,
            sampleRate: d.sampleRate,
            channelCount: d.channelCount,
            format: d.format,
            startSec: d.startSec,
            partial: d.partial,
          },
          { original: d.blob, peaks: d.peaks, framesPerBucket: d.framesPerBucket },
        );
      },
      onFellBackToDefault: () => notify('warning', t('recordAudio.fellBack', 'The saved input is not connected, so the default input is used.')),
    });
  }
  const controller = controllerRef.current;
  const open = inputOpen(state);
  const inTake = takeInProgress(state);

  const refreshDevices = useCallback(() => {
    void listInputDevices().then(setDevices).catch(() => setDevices([]));
  }, []);

  useEffect(() => {
    refreshDevices();
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    md?.addEventListener?.('devicechange', refreshDevices);
    return () => md?.removeEventListener?.('devicechange', refreshDevices);
  }, [refreshDevices]);

  // The panel closed: finish a take in progress (kept), release the mic, stop auditioning.
  useEffect(() => () => {
    void controller.dispose();
    const a = audition.current;
    if (a) {
      a.el.pause();
      URL.revokeObjectURL(a.url);
      audition.current = null;
    }
  }, [controller]);

  useEffect(() => {
    if (state.phase === 'ready') {
      setInput(controller.input);
      // Labels arrive once the page has been granted the input.
      refreshDevices();
      if (pendingRecord.current) {
        pendingRecord.current = false;
        controller.record();
      }
    } else if (state.phase === 'off') {
      setInput(null);
      pendingRecord.current = false;
    }
  }, [state.phase, controller, refreshDevices]);

  const meterRefs = useRef({
    fill: [] as Array<HTMLDivElement | null>,
    hold: [] as Array<HTMLDivElement | null>,
    led: [] as Array<HTMLButtonElement | null>,
    db: [] as Array<HTMLSpanElement | null>,
    clock: null as HTMLSpanElement | null,
  }).current;
  const channelCount = input?.channelCount ?? 1;
  useMeterLoop(controller, open, channelCount, meterRefs);

  // ── Input settings ──────────────────────────────────────────────────
  const reopenIfOpen = (): void => {
    if (open && !inTake) void controller.reopen();
  };
  const setPref = (patch: Partial<RecordAudioPrefs>, reopen = false): void => {
    prefs.set(patch);
    if (reopen) reopenIfOpen();
  };

  // ── Transport ───────────────────────────────────────────────────────
  const onRecord = (): void => {
    if (state.phase === 'off') {
      pendingRecord.current = true;
      void controller.open();
    } else if (state.phase === 'ready') {
      controller.record();
    }
  };

  // ── Takes ───────────────────────────────────────────────────────────
  const stopAudition = useCallback((): void => {
    const a = audition.current;
    if (!a) return;
    a.el.pause();
    URL.revokeObjectURL(a.url);
    audition.current = null;
    setAuditionId(null);
  }, []);

  const runBusy = async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(label);
    try {
      return await fn();
    } catch (err) {
      notify('error', t('recordAudio.renderFailed', 'Could not process the take: {error}', { error: err instanceof Error ? err.message : String(err) }));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const playTake = async (id: string): Promise<void> => {
    if (auditionId === id) {
      stopAudition();
      return;
    }
    stopAudition();
    const blob = await runBusy(t('recordAudio.busy.rendering', 'Rendering the edit…'), () => takeBlobForUse(id));
    if (!blob || typeof URL.createObjectURL !== 'function') return;
    const url = URL.createObjectURL(blob);
    const el = new Audio(url);
    el.onended = stopAudition;
    audition.current = { id, el, url };
    setAuditionId(id);
    await el.play().catch(() => stopAudition());
  };

  const deleteTake = async (take: TakeMeta): Promise<void> => {
    const ok = await customConfirm(
      t('recordAudio.deleteTitle', 'Delete take?'),
      t('recordAudio.deleteMessage', '“{name}” will be removed from this session. Anything already added to the project stays.', { name: take.name }),
      { confirmLabel: t('recordAudio.delete', 'Delete'), isDanger: true },
    );
    if (!ok) return;
    if (auditionId === take.id) stopAudition();
    useRecordAudioTakesStore.getState().remove(take.id);
  };

  const selected = takes.find((tk) => tk.id === selectedId) ?? null;

  const addToComposition = async (take: TakeMeta): Promise<void> => {
    if (!hasComposition()) {
      notify('warning', t('recordAudio.noComposition', 'Open or create a composition first, or use Add to Project.'));
      return;
    }
    const id = await runBusy(t('recordAudio.busy.adding', 'Adding…'), () => addTakeToComposition(take));
    if (id) notify('success', t('recordAudio.added', 'Added “{name}” to the composition.', { name: take.name }));
  };
  const addToProject = async (take: TakeMeta): Promise<void> => {
    const asset = await runBusy(t('recordAudio.busy.adding', 'Adding…'), () => addTakeToProject(take));
    if (asset) notify('success', t('recordAudio.addedProject', 'Added “{name}” to the project.', { name: take.name }));
  };
  const revert = (take: TakeMeta): void => {
    if (auditionId === take.id) stopAudition();
    useRecordAudioTakesStore.getState().setRendered(take.id, null, null, true);
  };

  const deviceValue = prefs.deviceId && devices.some((d) => d.id === prefs.deviceId) ? prefs.deviceId : '';
  const recordLabel = t('recordAudio.record', 'Record');

  return (
    <div className={styles.root} data-phase={state.phase}>
      {state.error && (
        <div className={styles.error} role="alert">
          <Icon name="warning" size="sm" />
          <span className={styles.errorText}>{errorText(state.error.kind, state.error.detail)}</span>
          <IconButton size="xs" aria-label={t('recordAudio.dismiss', 'Dismiss')} onClick={() => dispatch({ type: 'dismissError' })}>
            <Icon name="close" size="sm" />
          </IconButton>
        </div>
      )}

      {/* ── Input ─────────────────────────────────────────────────── */}
      <div className={styles.group}>
        {t('recordAudio.input', 'Input')}
        {input && (
          <span className={styles.groupAside}>
            {input.channelCount === 2 ? t('recordAudio.stereo', 'Stereo') : t('recordAudio.mono', 'Mono')} · {(input.sampleRate / 1000).toLocaleString()} kHz
          </span>
        )}
      </div>
      <div className={styles.row}>
        <span className={styles.label}>{t('recordAudio.device', 'Device')}</span>
        <div className={styles.control}>
          <select
            className={styles.select}
            aria-label={t('recordAudio.device', 'Device')}
            value={deviceValue}
            disabled={inTake}
            onChange={(e) => setPref({ deviceId: e.target.value || null }, true)}
          >
            <option value="">{t('recordAudio.defaultDevice', 'System default')}</option>
            {devices.filter((d) => d.id && d.id !== 'default').map((d, i) => (
              <option key={d.id} value={d.id}>{d.label || t('recordAudio.unnamedDevice', 'Input {n}', { n: i + 1 })}</option>
            ))}
          </select>
        </div>
      </div>
      <div className={styles.row}>
        <span className={styles.label}>{t('recordAudio.inputGain', 'Input gain')}</span>
        <div className={styles.control}>
          <ValueField
            value={prefs.inputGainDb}
            min={-24}
            max={24}
            step={0.1}
            precision={1}
            unit="dB"
            aria-label={t('recordAudio.inputGain', 'Input gain')}
            onScrub={(v) => controller.setInputGainDb(v)}
            onChange={(v) => { setPref({ inputGainDb: v }); controller.setInputGainDb(v); }}
          />
        </div>
      </div>
      <div className={styles.checks}>
        <Checkbox label={t('recordAudio.echoCancellation', 'Echo cancellation')} checked={prefs.echoCancellation} disabled={inTake} onChange={(e) => setPref({ echoCancellation: e.target.checked }, true)} />
        <Checkbox label={t('recordAudio.noiseSuppression', 'Noise suppression')} checked={prefs.noiseSuppression} disabled={inTake} onChange={(e) => setPref({ noiseSuppression: e.target.checked }, true)} />
        <Checkbox label={t('recordAudio.autoGain', 'Auto gain')} checked={prefs.autoGainControl} disabled={inTake} onChange={(e) => setPref({ autoGainControl: e.target.checked }, true)} />
      </div>
      <div className={cn(styles.meter, !open && styles.meterIdle)} role="group" aria-label={t('recordAudio.meter', 'Input level')}>
        {Array.from({ length: channelCount }, (_, c) => (
          <div key={c} className={styles.meterRow}>
            <span className={styles.meterCh}>{channelCount === 2 ? (c === 0 ? 'L' : 'R') : ''}</span>
            <div className={styles.meterBar}>
              <div ref={(el) => { meterRefs.fill[c] = el; }} className={styles.meterFill} />
              <div ref={(el) => { meterRefs.hold[c] = el; }} className={styles.meterHold} />
            </div>
            <button
              type="button"
              ref={(el) => { meterRefs.led[c] = el; }}
              className={styles.clipLed}
              title={t('recordAudio.clipReset', 'Clip — click to reset')}
              aria-label={t('recordAudio.clipReset', 'Clip — click to reset')}
              onClick={() => controller.resetClip()}
            />
            <span ref={(el) => { meterRefs.db[c] = el; }} className={styles.meterDb}>-∞</span>
          </div>
        ))}
      </div>
      {state.phase === 'off' ? (
        <div className={styles.actions}>
          <Button size="sm" leftIcon={<Icon name="mic" size="sm" />} onClick={() => void controller.open()}>
            {t('recordAudio.turnOn', 'Turn On Input')}
          </Button>
        </div>
      ) : state.phase === 'opening' ? (
        <p className={styles.note}>{t('recordAudio.opening', 'Opening the input…')}</p>
      ) : null}

      {/* ── Record ────────────────────────────────────────────────── */}
      <div className={styles.group}>{t('recordAudio.recordGroup', 'Record')}</div>
      <div className={styles.transport}>
        <IconButton
          size="sm"
          variant="secondary"
          aria-label={recordLabel}
          tooltip={recordLabel}
          active={state.phase === 'recording'}
          disabled={!(state.phase === 'off' || state.phase === 'ready')}
          onClick={onRecord}
        >
          <span className={styles.recordDot}><Icon name="circle" size="sm" /></span>
        </IconButton>
        {state.phase === 'paused' ? (
          <IconButton size="sm" variant="secondary" aria-label={t('recordAudio.resume', 'Resume')} tooltip={t('recordAudio.resume', 'Resume')} onClick={() => controller.resume()}>
            <Icon name="play" size="sm" />
          </IconButton>
        ) : (
          <IconButton size="sm" variant="secondary" aria-label={t('recordAudio.pause', 'Pause')} tooltip={t('recordAudio.pause', 'Pause')} disabled={state.phase !== 'recording'} onClick={() => controller.pause()}>
            <Icon name="pause" size="sm" />
          </IconButton>
        )}
        <IconButton
          size="sm"
          variant="secondary"
          aria-label={t('recordAudio.stop', 'Stop')}
          tooltip={t('recordAudio.stop', 'Stop')}
          disabled={!(state.phase === 'countIn' || state.phase === 'recording' || state.phase === 'paused')}
          onClick={() => void controller.stop()}
        >
          <Icon name="stop" size="sm" />
        </IconButton>
        {state.phase === 'countIn' && <span className={styles.countIn} aria-live="assertive">{state.countdown}</span>}
        <span
          ref={(el) => { meterRefs.clock = el; }}
          className={cn(styles.clock, (state.phase === 'recording' || state.phase === 'paused') && styles.clockLive)}
          aria-label={t('recordAudio.elapsed', 'Elapsed')}
        >
          {formatTakeTime(0)}
        </span>
      </div>
      <div className={styles.checks}>
        <Checkbox label={t('recordAudio.countIn', 'Count in (3-2-1)')} checked={prefs.countIn} disabled={inTake} onChange={(e) => setPref({ countIn: e.target.checked })} />
        <Checkbox label={t('recordAudio.playWhileRecording', 'Play composition while recording')} checked={prefs.playWhileRecording} disabled={inTake} onChange={(e) => setPref({ playWhileRecording: e.target.checked })} />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>{t('recordAudio.format', 'Format')}</span>
        <div className={styles.control}>
          <select
            className={styles.select}
            aria-label={t('recordAudio.format', 'Format')}
            value={prefs.format}
            disabled={inTake}
            onChange={(e) => setPref({ format: e.target.value === 'float32' ? 'float32' : 'pcm24' })}
          >
            <option value="pcm24">{t('recordAudio.format24', 'WAV, 24-bit')}</option>
            <option value="float32">{t('recordAudio.formatFloat', 'WAV, 32-bit float')}</option>
          </select>
        </div>
      </div>
      <p className={styles.note}>
        {prefs.playWhileRecording
          ? t('recordAudio.hintPlayback', 'Takes start at the playhead. Use headphones, or the composition’s sound is recorded too.')
          : t('recordAudio.hint', 'Takes start at the playhead.')}
      </p>

      {/* ── Takes ─────────────────────────────────────────────────── */}
      <div className={styles.group}>
        {t('recordAudio.takes', 'Takes')}
        {takes.length > 0 && <span className={styles.groupAside}>{takes.length}</span>}
      </div>
      {takes.length === 0 ? (
        <p className={styles.note}>{t('recordAudio.noTakes', 'No takes yet. Press Record to start one.')}</p>
      ) : (
        <ul className={styles.takes} aria-label={t('recordAudio.takes', 'Takes')}>
          {takes.map((tk) => (
            <li
              key={tk.id}
              className={cn(styles.take, tk.id === selectedId && styles.takeSelected)}
              aria-selected={tk.id === selectedId}
              onClick={() => useRecordAudioTakesStore.getState().select(tk.id)}
              onDoubleClick={() => setRenaming(tk.id)}
            >
              {renaming === tk.id ? (
                <input
                  className={styles.renameInput}
                  aria-label={t('recordAudio.rename', 'Rename take')}
                  defaultValue={tk.name}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => { useRecordAudioTakesStore.getState().rename(tk.id, e.currentTarget.value); setRenaming(null); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') { e.currentTarget.value = tk.name; e.currentTarget.blur(); }
                    e.stopPropagation();
                  }}
                />
              ) : (
                <span className={styles.takeName} title={tk.name}>{tk.name}</span>
              )}
              <span className={styles.takeMeta} title={tk.partial ? t('recordAudio.partial', 'Cut short — the take was stopped early') : undefined}>
                {tk.partial ? '! ' : ''}{formatTakeTime(tk.durationSec)}
              </span>
              <IconButton
                size="xs"
                aria-label={auditionId === tk.id ? t('recordAudio.stopAudition', 'Stop playing') : t('recordAudio.audition', 'Play take')}
                tooltip={auditionId === tk.id ? t('recordAudio.stopAudition', 'Stop playing') : t('recordAudio.audition', 'Play take')}
                onClick={(e) => { e.stopPropagation(); void playTake(tk.id); }}
              >
                <Icon name={auditionId === tk.id ? 'stop' : 'play'} size="sm" />
              </IconButton>
              <IconButton
                size="xs"
                aria-label={t('recordAudio.deleteTake', 'Delete take')}
                tooltip={t('recordAudio.deleteTake', 'Delete take')}
                onClick={(e) => { e.stopPropagation(); void deleteTake(tk); }}
              >
                <Icon name="trash" size="sm" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      {/* ── Edit ──────────────────────────────────────────────────── */}
      {selected && (
        <>
          <div className={styles.group}>
            {t('recordAudio.editGroup', 'Edit')}
            <span className={styles.groupAside}>{selected.name}</span>
          </div>
          <TakeEditor take={selected} />
          <div className={styles.actions}>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => revert(selected)}>
              {t('recordAudio.revert', 'Revert to Original')}
            </Button>
          </div>
          <div className={styles.actions}>
            <Button size="sm" variant="primary" disabled={!!busy || inTake} onClick={() => void addToComposition(selected)}>
              {t('recordAudio.addToComposition', 'Add to Composition')}
            </Button>
            <Button size="sm" disabled={!!busy || inTake} onClick={() => void addToProject(selected)}>
              {t('recordAudio.addToProject', 'Add to Project')}
            </Button>
          </div>
          <p className={styles.note}>
            {busy ?? t('recordAudio.addHint', 'Adds at {time} — where the take started — as an audio layer you can trim and mix like any other.', { time: formatTakeTime(selected.startSec + editedSpan(selected).offsetSec) })}
          </p>
        </>
      )}
    </div>
  );
}
