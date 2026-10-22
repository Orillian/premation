/**
 * The Record Audio panel's Edit section for the selected take: the waveform
 * with draggable trim in / out, then the edit's rows — gain, normalize, fades,
 * high-pass, noise gate — and the verbs. The settings live on the take
 * (`recordAudioTakesStore`); the audio is rendered from the ORIGINAL when it
 * is auditioned or added (`takeBlobForUse`), so "Revert to Original" only
 * drops the render and resets the rows.
 *
 * A trim drag re-renders this section (it is a pointer gesture, not playback);
 * the waveform itself is redrawn only when its peaks or size change.
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { Checkbox } from '@components/Checkbox';
import { ValueField } from '@components/ValueField';
import { clampEdit, resamplePeaks, type NormalizeMode, type TakeEditParams } from '@core/audio/recording/dsp';
import { formatTakeTime } from '@core/audio/recording/takes';
import { t } from '@core/i18n';
import { takeAudio, useRecordAudioTakesStore, type TakeMeta } from '@stores/recordAudioTakesStore';
import styles from './RecordAudioPanel.module.css';

function useElementWidth(): { ref: RefObject<HTMLDivElement>; width: number } {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

function Waveform({ take, onTrim }: { take: TakeMeta; onTrim: (patch: Partial<TakeEditParams>) => void }): JSX.Element {
  const { ref, width } = useElementWidth();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef<'in' | 'out' | null>(null);
  const dur = take.durationSec;
  const p = clampEdit(take.edit, dur);
  const inFrac = dur > 0 ? p.trimInSec / dur : 0;
  const outFrac = dur > 0 ? (p.trimOutSec ?? dur) / dur : 1;

  useEffect(() => {
    const canvas = canvasRef.current;
    const a = takeAudio(take.id);
    if (!canvas || !a || width <= 0) return;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const h = canvas.clientHeight || 72;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, h);
    // The stroke takes the element's CSS colour (a theme token), never a literal.
    ctx.fillStyle = getComputedStyle(canvas).color;
    const cols = Math.max(1, Math.floor(width));
    const pk = resamplePeaks(a.peaks, cols);
    const mid = h / 2;
    for (let x = 0; x < cols; x++) {
      const lo = pk[2 * x]!;
      const hi = pk[2 * x + 1]!;
      const y0 = mid - hi * mid;
      const y1 = mid - lo * mid;
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }, [take.id, width]);

  const secAt = (clientX: number): number => {
    const el = ref.current;
    if (!el || dur <= 0) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(dur, Math.max(0, ((clientX - r.left) / Math.max(1, r.width)) * dur));
  };
  const onDown = (which: 'in' | 'out') => (e: ReactPointerEvent<HTMLDivElement>): void => {
    dragging.current = which;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const which = dragging.current;
    if (!which) return;
    const s = secAt(e.clientX);
    const minLen = 0.05;
    if (which === 'in') onTrim({ trimInSec: Math.min(s, (p.trimOutSec ?? dur) - minLen) });
    else onTrim({ trimOutSec: Math.max(s, p.trimInSec + minLen) });
  };
  const onUp = (): void => { dragging.current = null; };
  const nudge = (which: 'in' | 'out', delta: number): void => {
    if (which === 'in') onTrim({ trimInSec: Math.max(0, Math.min(p.trimInSec + delta, (p.trimOutSec ?? dur) - 0.05)) });
    else onTrim({ trimOutSec: Math.min(dur, Math.max((p.trimOutSec ?? dur) + delta, p.trimInSec + 0.05)) });
  };

  return (
    <div ref={ref} className={styles.wave} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <canvas ref={canvasRef} className={styles.waveCanvas} aria-hidden="true" />
      <div className={styles.waveShade} style={{ left: 0, width: `${inFrac * 100}%` }} />
      <div className={styles.waveShade} style={{ left: `${outFrac * 100}%`, right: 0 }} />
      <div
        role="slider"
        tabIndex={0}
        aria-label={t('recordAudio.edit.trimIn', 'Trim in')}
        aria-valuemin={0}
        aria-valuemax={Number(dur.toFixed(2))}
        aria-valuenow={Number(p.trimInSec.toFixed(2))}
        aria-valuetext={formatTakeTime(p.trimInSec)}
        className={styles.waveHandle}
        style={{ left: `${inFrac * 100}%` }}
        onPointerDown={onDown('in')}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') { nudge('in', -0.1); e.preventDefault(); }
          if (e.key === 'ArrowRight') { nudge('in', 0.1); e.preventDefault(); }
        }}
      />
      <div
        role="slider"
        tabIndex={0}
        aria-label={t('recordAudio.edit.trimOut', 'Trim out')}
        aria-valuemin={0}
        aria-valuemax={Number(dur.toFixed(2))}
        aria-valuenow={Number((p.trimOutSec ?? dur).toFixed(2))}
        aria-valuetext={formatTakeTime(p.trimOutSec ?? dur)}
        className={styles.waveHandle}
        style={{ left: `${outFrac * 100}%` }}
        onPointerDown={onDown('out')}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') { nudge('out', -0.1); e.preventDefault(); }
          if (e.key === 'ArrowRight') { nudge('out', 0.1); e.preventDefault(); }
        }}
      />
    </div>
  );
}

interface NumRowProps {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  step: number;
  precision?: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}

function NumRow({ label, value, unit, min, max, step, precision = 1, disabled, onChange }: NumRowProps): JSX.Element {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <div className={styles.control}>
        <ValueField value={value} onChange={onChange} min={min} max={max} step={step} precision={precision} unit={unit} disabled={disabled} aria-label={label} />
      </div>
    </div>
  );
}

export function TakeEditor({ take }: { take: TakeMeta }): JSX.Element {
  const setEdit = useRecordAudioTakesStore((s) => s.setEdit);
  const e = take.edit;
  const patch = (p: Partial<TakeEditParams>): void => setEdit(take.id, p);
  const span = clampEdit(e, take.durationSec);
  const len = (span.trimOutSec ?? take.durationSec) - span.trimInSec;
  const normalizeOptions: Array<{ value: NormalizeMode; label: string }> = [
    { value: 'off', label: t('recordAudio.edit.normalizeOff', 'Off') },
    { value: 'peak', label: t('recordAudio.edit.normalizePeak', 'Peak') },
    { value: 'loudness', label: t('recordAudio.edit.normalizeLoudness', 'Loudness') },
    { value: 'both', label: t('recordAudio.edit.normalizeBoth', 'Loudness, peak-limited') },
  ];

  return (
    <>
      <Waveform take={take} onTrim={patch} />
      <div className={styles.row}>
        <span className={styles.label}>{t('recordAudio.edit.range', 'Range')}</span>
        <div className={styles.control}>
          <span className={styles.value}>{formatTakeTime(span.trimInSec)}</span>
          <span className={styles.unit}>→</span>
          <span className={styles.value}>{formatTakeTime(span.trimOutSec ?? take.durationSec)}</span>
          <span className={styles.unit}>({formatTakeTime(len)})</span>
        </div>
      </div>
      <NumRow label={t('recordAudio.edit.gain', 'Gain')} value={e.gainDb} unit="dB" min={-48} max={24} step={0.1} onChange={(v) => patch({ gainDb: v })} />
      <div className={styles.row}>
        <span className={styles.label}>{t('recordAudio.edit.normalize', 'Normalize')}</span>
        <div className={styles.control}>
          <select
            className={styles.select}
            aria-label={t('recordAudio.edit.normalize', 'Normalize')}
            value={e.normalize}
            onChange={(ev) => patch({ normalize: ev.target.value as NormalizeMode })}
          >
            {normalizeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>
      {(e.normalize === 'peak' || e.normalize === 'both') && (
        <NumRow label={t('recordAudio.edit.peakCeiling', 'Peak ceiling')} value={e.peakCeilingDb} unit="dBFS" min={-24} max={0} step={0.1} onChange={(v) => patch({ peakCeilingDb: v })} />
      )}
      {(e.normalize === 'loudness' || e.normalize === 'both') && (
        <NumRow label={t('recordAudio.edit.loudnessTarget', 'Loudness target')} value={e.loudnessTargetLufs} unit="LUFS" min={-36} max={-6} step={0.5} onChange={(v) => patch({ loudnessTargetLufs: v })} />
      )}
      <NumRow label={t('recordAudio.edit.fadeIn', 'Fade in')} value={e.fadeInSec} unit="s" min={0} max={Math.max(0, len)} step={0.01} precision={2} onChange={(v) => patch({ fadeInSec: v })} />
      <NumRow label={t('recordAudio.edit.fadeOut', 'Fade out')} value={e.fadeOutSec} unit="s" min={0} max={Math.max(0, len)} step={0.01} precision={2} onChange={(v) => patch({ fadeOutSec: v })} />
      <div className={styles.row}>
        <Checkbox
          label={t('recordAudio.edit.highPass', 'High-pass (rumble)')}
          checked={e.highPass.enabled}
          onChange={(ev) => patch({ highPass: { ...e.highPass, enabled: ev.target.checked } })}
        />
        <div className={styles.control}>
          <ValueField value={e.highPass.hz} onChange={(v) => patch({ highPass: { ...e.highPass, hz: v } })} min={20} max={400} step={1} precision={0} unit="Hz" disabled={!e.highPass.enabled} aria-label={t('recordAudio.edit.highPassFrequency', 'High-pass frequency')} />
        </div>
      </div>
      <div className={styles.row}>
        <Checkbox
          label={t('recordAudio.edit.gate', 'Noise gate')}
          checked={e.gate.enabled}
          onChange={(ev) => patch({ gate: { ...e.gate, enabled: ev.target.checked } })}
        />
        <div className={styles.control}>
          <ValueField value={e.gate.thresholdDb} onChange={(v) => patch({ gate: { ...e.gate, thresholdDb: v } })} min={-90} max={-10} step={0.5} precision={1} unit="dB" disabled={!e.gate.enabled} aria-label={t('recordAudio.edit.gateThreshold', 'Gate threshold')} />
        </div>
      </div>
    </>
  );
}
