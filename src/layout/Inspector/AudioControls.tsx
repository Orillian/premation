/**
 * AudioControls — the "Audio" section of the inspector, shown only for audio
 * layers. Displays the decoded waveform with a playhead marker and edits
 * level / timing / mute. Playback itself is driven by the transport via the
 * AudioEngine; this panel just edits the layer.
 *
 * **Timing edits go to the timeline CLIP**, not to a private copy on the Audio
 * component. Start / In / Out here and the layer's bar in the timeline are the
 * same numbers seen two ways — drag the bar and these fields move, type here
 * and the bar moves. (They used to be two unrelated sets of numbers, and only
 * the inspector's set was ever read; see `audioScene` for the whole story.)
 * Layers with no bar — audio nested in a plain group, or a headless scene —
 * fall back to editing the component props, which is what the engine reads for
 * them too.
 */

import { useEffect, useMemo, useState } from 'react';
import { SLOT, t, tAround } from '@core/i18n';
import { ValueField } from '@components/ValueField';
import { Switch } from '@components/Switch';
import { Slider } from '@components/Slider';
import { Popover } from '@components/Popover';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { getTime, useThrottledTime } from '@stores/playbackClockStore';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorKeys, useRetainTree } from '@hooks/useMirror';
import { uiKindOf } from '@core/mirror/layerKinds';
import {
  audioClipTimings,
  sourceSeconds,
  staticLevelDb,
  staticPan,
  unbarredTiming,
} from '@core/mirror/audio';
import { audioEngine } from '@core/audio/AudioEngine';
import { AudioEffectsSection } from './AudioEffectsSection';
import { previewEngineJob } from '@core/engine/engineJobs';
import {
  AUDIO_AMPLITUDE_PROP,
  DEFAULT_AUDIO_KEYFRAME_OPTIONS,
  type AudioKeyframeOptions,
} from '@core/audio/audioKeyframes';
import { useUIStore } from '@stores/uiStore';
import { waveformPath } from '@core/audio/waveform';
import { InspectorRow } from '@components/Inspector';
import { KeyframeRow } from './KeyframeRow';
import {
  AUDIO_LEVEL_DB_PROP, MIN_LEVEL_DB, MAX_LEVEL_DB,
  AUDIO_PAN_PROP, MIN_PAN, MAX_PAN,
} from '@core/audio/audioParams';
import { DEFAULT_FADE_SEC, type FadeSide } from '@core/audio/audioFades';
import { useEngineEdit } from './useEngineEdit';
import { scalarValueCommands } from './inspectorEdits';
import { barTimingCommand, convertAudioToKeyframesEdit, fadeEdit, muteEdit, unbarredTimingCommand } from './audioEdits';
import { openSilenceRemovalDialog } from './SilenceRemovalDialog';
import { openDuckingDialog } from './DuckingDialog';
import { openGateDialog } from './GateDialog';
import styles from './AudioControls.module.css';
import toolStyles from './AudioToolDialog.module.css';

const WAVE_W = 264;
const WAVE_H = 52;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Where the layer's audible span sits and which slice of the file it plays. */
interface Timing {
  /** Clip id when the timeline owns this span; null when props do. */
  clipId: string | null;
  startSec: number;
  inSec: number;
  outSec: number;
}

export function AudioControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  // The document mirror (B4): the layer's header (bar, switches, source), its
  // property tree (level, pan, the bar-less clip fields), its parent's header
  // (a group's members have no bar) and the source item (the file's length).
  const m = documentMirror();
  const layer = m.layer(nodeId);
  useRetainTree(nodeId);
  useMirrorKeys([
    `layer:${nodeId}`,
    `tree:${nodeId}`,
    ...(layer?.parent ? [`layer:${layer.parent}`] : []),
    ...(layer?.source ? [`item:${layer.source}`] : []),
  ]);
  // Display time (throttled) — never the raw clock in render.
  const time = useThrottledTime();
  // A scrubbed timing / level field is ONE gesture; a typed value one entry.
  const timingEdit = useEngineEdit();
  // Re-render when the engine finishes decoding a waveform.
  const [, setLoaded] = useState(0);
  useEffect(() => audioEngine.onChange(() => setLoaded((n) => n + 1)), []);

  const isAudio = uiKindOf(layer) === 'audio';
  // The footage item the layer plays is the decoder's asset id.
  const assetId = isAudio ? layer?.source ?? '' : '';

  // Kick off decoding for this asset (idempotent) so the waveform appears.
  useEffect(() => {
    // The item's playable media (`ItemInfo.mediaUrl`), decoded for the waveform display only.
    const url = assetId ? documentMirror().item(assetId)?.mediaUrl : undefined;
    if (assetId && url) void audioEngine.load(assetId, url);
  }, [assetId]);

  const wave = assetId ? audioEngine.getWaveform(assetId) : undefined;
  const path = useMemo(() => (wave ? waveformPath(wave.peaks, WAVE_W, WAVE_H) : ''), [wave]);

  // The layer's bar (a split makes a new layer: one bar each); a group's
  // member has none and plays from its own Start / In / Out.
  const clipTimings = audioClipTimings(m, nodeId);
  const activeIndex = Math.max(
    0,
    clipTimings.findIndex((ct) => time >= ct.startSec && time < ct.startSec + (ct.outSec - ct.inSec)),
  );

  if (!layer || !isAudio) return null;

  const duration = sourceSeconds(m, nodeId);
  // `audio/levels` — dB; an older project's percent is migrated by the engine
  // (see the KeyframeRow below and `staticLevelDb` in audioScene).
  const levelDb = staticLevelDb(m, nodeId);
  // Centred is the absence of the prop, not a stored 0 — see `panOf`.
  const pan = staticPan(m, nodeId);
  const muted = !layer.switches.audioEnabled;

  const active = clipTimings[activeIndex];
  const timing: Timing = active
    ? { clipId: active.id, startSec: active.startSec, inSec: active.inSec, outSec: active.outSec }
    : { clipId: null, ...unbarredTiming(m, nodeId) };

  /** Level / Pan typed or scrubbed with the stopwatch off (KeyframeRow's static route). */
  const writeStatic = (track: string, label: string, v: number): void => {
    timingEdit.send(`Set ${label}`, scalarValueCommands(track, [{ nodeId, value: v }], { seconds: getTime() }));
  };

  const fadeHere = (side: FadeSide): void => {
    void fadeEdit([nodeId], side);
  };

  // ── Timing writers ───────────────────────────────────────────────
  // A layer IS its bar (ENGINE_API.md §3.1): Start moves the bar's head to the
  // value, In / Out trim its edges — `setLayerTiming`, absolute, so a scrub is
  // one gesture. The in-point measures source seconds from the head, the
  // out-point from the head too, hence `start + (out − in)`. A layer with no
  // bar edits its Audio component's own Start / In / Out (`audio/clip*`).
  // A legacy multi-bar layer edits the layer's first / last bar (the API's
  // bar model); its Start moves the whole layer.
  const sendTiming = (field: 'start' | 'in' | 'out', label: string, v: number): void => {
    timingEdit.send(label, timing.clipId ? barTimingCommand(nodeId, field, timing, v) : unbarredTimingCommand(nodeId, field, v));
  };
  const setStart = (v: number): void => sendTiming('start', t('inspector.audioControls.clipStart', 'Clip start'), Math.max(0, v));
  const setIn = (v: number): void => sendTiming('in', t('inspector.audioControls.inPoint', 'In point'), clamp(v, 0, timing.outSec));
  const setOut = (v: number): void => sendTiming('out', t('inspector.audioControls.outPoint', 'Out point'), clamp(v, timing.inSec, duration || Infinity));

  // Waveform geometry: the trimmed-away head/tail are shaded, and the playhead
  // draws at the SOURCE position the comp playhead currently maps to (so it
  // tracks the sound even when the bar has been slid or trimmed).
  const spanSec = Math.max(0, timing.outSec - timing.inSec);
  const localSourceSec = timing.inSec + (time - timing.startSec);
  const overClip = time >= timing.startSec && time < timing.startSec + spanSec;
  const toX = (sec: number): number => (duration > 0 ? clamp(sec / duration, 0, 1) * WAVE_W : 0);
  const playX = toX(localSourceSec);
  const inX = toX(timing.inSec);
  const outX = duration > 0 ? toX(timing.outSec) : WAVE_W;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        {clipTimings.length > 1 ? (
          <div className={styles.clipBadge} title={t('inspector.audioControls.clipSplit', "This layer's bar was split — editing the clip under the playhead")}>
            {t('inspector.audioControls.clipBadge', 'Clip {i}/{n}', { i: activeIndex + 1, n: clipTimings.length })}
          </div>
        ) : null}
      </div>

      <div className={styles.waveBox}>
        {wave ? (
          <svg
            className={styles.wave}
            viewBox={`0 0 ${WAVE_W} ${WAVE_H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={t('inspector.audioControls.waveform', 'Waveform')}
          >
            <path d={path} className={styles.fill} />
            <rect x={0} y={0} width={inX} height={WAVE_H} className={styles.trim} />
            <rect x={outX} y={0} width={Math.max(0, WAVE_W - outX)} height={WAVE_H} className={styles.trim} />
            <line x1={inX} y1={0} x2={inX} y2={WAVE_H} className={styles.trimEdge} />
            <line x1={outX} y1={0} x2={outX} y2={WAVE_H} className={styles.trimEdge} />
            {overClip ? <line x1={playX} y1={0} x2={playX} y2={WAVE_H} className={styles.playhead} /> : null}
          </svg>
        ) : (
          <div className={styles.decoding}>{t('inspector.audioControls.decodingWaveform', 'Decoding waveform…')}</div>
        )}
      </div>

      {/* Level is `audioLevelDb`, keyed through the same KeyframeRow a video
          layer's track uses — one control, one prop, one stopwatch for every
          layer that makes a sound. The legacy `__level` percent is only read
          (via `percentToDb`) so an older project opens at the gain it had; the
          first edit writes dB and the percent stops being consulted. */}
      <KeyframeRow
        nodeId={nodeId}
        prop={AUDIO_LEVEL_DB_PROP}
        label={t('inspector.audioControls.level', 'Level')}
        value={levelDb}
        unit="dB"
        min={MIN_LEVEL_DB}
        max={MAX_LEVEL_DB}
        precision={1}
        onStatic={(v) => writeStatic(AUDIO_LEVEL_DB_PROP, 'Level', v)}
      />

      <KeyframeRow
        nodeId={nodeId}
        prop={AUDIO_PAN_PROP}
        label={t('inspector.audioControls.pan', 'Pan')}
        value={pan}
        unit="%"
        min={MIN_PAN}
        max={MAX_PAN}
        onStatic={(v) => writeStatic(AUDIO_PAN_PROP, 'Pan', v)}
      />

      <InspectorRow label={t('inspector.audioControls.mute', 'Mute')} align="center">
        <Switch checked={muted} onChange={(e) => muteEdit(nodeId, e.currentTarget.checked)} aria-label={t('inspector.audioControls.muteAudio', 'Mute audio')} />
      </InspectorRow>

      <div className={styles.sectionLabel}>
        {t('inspector.audioControls.timing', 'Timing')}
        <span className={styles.hint}>{timing.clipId ? t('inspector.audioControls.followsBar', 'follows the timeline bar') : t('inspector.audioControls.noBar', 'no timeline bar')}</span>
      </div>

      <InspectorRow label={t('inspector.audioControls.start', 'Start')} align="center">
        <ValueField
          value={timing.startSec}
          min={0}
          step={0.05}
          unit="s"
          precision={2}
          onChange={setStart}
          {...timingEdit.scrub('Clip start')}
          aria-label={t('inspector.audioControls.clipStart', 'Clip start')}
        />
      </InspectorRow>
      <InspectorRow label={t('inspector.audioControls.in', 'In')} align="center">
        <ValueField
          value={timing.inSec}
          min={0}
          max={timing.outSec}
          step={0.05}
          unit="s"
          precision={2}
          onChange={setIn}
          {...timingEdit.scrub('In point')}
          aria-label={t('inspector.audioControls.inPoint', 'In point')}
        />
      </InspectorRow>
      <InspectorRow label={t('inspector.audioControls.out', 'Out')} align="center">
        <ValueField
          value={timing.outSec}
          min={timing.inSec}
          max={duration || undefined}
          step={0.05}
          unit="s"
          precision={2}
          onChange={setOut}
          {...timingEdit.scrub('Out point')}
          aria-label={t('inspector.audioControls.outPoint', 'Out point')}
        />
      </InspectorRow>
      <InspectorRow label={t('inspector.audioControls.duration', 'Duration')} align="center">
        <span className={styles.readonlyVal}>
          {spanSec.toFixed(2)}s <span className={styles.muted}>{t('inspector.audioControls.durationOf', 'of {d}s', { d: duration.toFixed(2) })}</span>
        </span>
      </InspectorRow>

      <div className={styles.sectionLabel}>{t('inspector.audioControls.effects', 'Effects')}</div>
      <AudioEffectsSection nodeId={nodeId} />

      <div className={styles.sectionLabel}>
        {t('inspector.audioControls.edit', 'Edit')}
        <span className={styles.hint}>{t('inspector.audioControls.editHint', 'cuts and levels')}</span>
      </div>
      <div className={toolStyles.toolButtons}>
        {/* The fades write ordinary level keyframes (see `audioFades`), so they
            are reshapeable in the graph editor afterwards and compose with a
            duck rather than replacing it. Wrapped in a history entry here
            because the command path is not the only way in. */}
        <button
          type="button"
          className={toolStyles.toolButton}
          title={t('inspector.audioControls.fadeInTip', "Ramp up from silence over {s}s from where this layer's bar starts", { s: DEFAULT_FADE_SEC })}
          onClick={() => fadeHere('in')}
        >
          {t('inspector.audioControls.fadeIn', 'Fade in')}
        </button>
        <button
          type="button"
          className={toolStyles.toolButton}
          title={t('inspector.audioControls.fadeOutTip', "Ramp down to silence over the last {s}s of this layer's bar", { s: DEFAULT_FADE_SEC })}
          onClick={() => fadeHere('out')}
        >
          {t('inspector.audioControls.fadeOut', 'Fade out')}
        </button>
        <button
          type="button"
          className={toolStyles.toolButton}
          title={t('inspector.audioControls.removeSilenceTip', 'Find the dead air in this take and cut it out, closing the gaps')}
          onClick={() => openSilenceRemovalDialog(nodeId)}
        >
          {t('inspector.audioControls.removeSilence', 'Remove silence…')}
        </button>
        <button
          type="button"
          className={toolStyles.toolButton}
          title={t('inspector.audioControls.duckTip', 'Hold this layer’s level down whenever another layer is talking')}
          onClick={() => openDuckingDialog(nodeId)}
        >
          {t('inspector.audioControls.duck', 'Duck under voice…')}
        </button>
        <button
          type="button"
          className={toolStyles.toolButton}
          title={t('inspector.audioControls.gateTip', 'Pull this layer down wherever it is below a threshold — room tone, hiss')}
          onClick={() => openGateDialog(nodeId)}
        >
          {t('inspector.audioControls.gate', 'Noise gate…')}
        </button>
      </div>

      <div className={styles.sectionLabel}>{t('inspector.audioControls.keyframes', 'Keyframes')}</div>
      <AudioToKeyframes nodeId={nodeId} />
    </div>
  );
}

// ── Convert audio to keyframes ─────────────────────────────────────

/** Detail presets — a plain-language front end for `minDelta` + `frameStep`. */
const DETAIL_PRESETS = [
  { id: 'coarse', frameStep: 4, minDelta: 8 },
  { id: 'balanced', frameStep: 2, minDelta: 3 },
  { id: 'detailed', frameStep: 1, minDelta: 1 },
  { id: 'exact', frameStep: 1, minDelta: 0 },
] as const;

type DetailId = (typeof DETAIL_PRESETS)[number]['id'];

/** Display labels for the detail presets (translated at call time, never at module load). */
function detailLabel(id: DetailId): string {
  switch (id) {
    case 'coarse': return t('inspector.audioControls.detailCoarse', 'Coarse');
    case 'balanced': return t('inspector.audioControls.detailBalanced', 'Balanced');
    case 'detailed': return t('inspector.audioControls.detailDetailed', 'Detailed');
    case 'exact': return t('inspector.audioControls.detailExact', 'Every frame');
  }
}

/**
 * The conversion control: a popover of options with a LIVE keyframe count, then
 * one apply. The count matters — this writes a whole track, and the old
 * one-click button silently produced thousands of keyframes with no warning and
 * no way to ask for fewer.
 */
function AudioToKeyframes({ nodeId }: { nodeId: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<DetailId>('balanced');
  const [smoothing, setSmoothing] = useState(3);
  const [gain, setGain] = useState(1);
  const [busy, setBusy] = useState(false);
  /** The keyframe count the conversion would write (the engine's dry run); null until known. */
  const [estimate, setEstimate] = useState<number | null>(null);
  const [decoding, setDecoding] = useState(false);

  const preset = DETAIL_PRESETS.find((d) => d.id === detail) ?? DETAIL_PRESETS[1];
  const options: AudioKeyframeOptions = useMemo(() => ({
    ...DEFAULT_AUDIO_KEYFRAME_OPTIONS,
    frameStep: preset.frameStep,
    minDelta: preset.minDelta,
    smoothing,
    gain,
  }), [preset.frameStep, preset.minDelta, smoothing, gain]);

  // The estimate is the engine's own dry run (the audioAnalysis job with
  // apply: false), debounced, so the count shown is the count written.
  // Cancelled on close so a slow analysis can't write into an unmounted popover.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDecoding(true);
    const timer = setTimeout(() => {
      void previewEngineJob<{ amplitude?: { keyframes: number } }>({
        kind: 'audioAnalysis',
        value: {
          layer: nodeId, beats: false, amplitudeKeyframes: true, silence: false, removeSilence: false, beatMarkers: false,
          amplitudeFrameStep: Math.max(1, Math.floor(options.frameStep)), amplitudeMinDelta: options.minDelta,
          amplitudeSmoothing: Math.max(1, Math.floor(options.smoothing)), amplitudeGain: options.gain,
        },
      }).then((out) => {
        if (cancelled) return;
        setEstimate(out && out.status === 'done' ? out.result?.amplitude?.keyframes ?? 0 : null);
        setDecoding(false);
      }, () => {
        if (!cancelled) setDecoding(false);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, options, nodeId]);

  const apply = async (): Promise<void> => {
    setBusy(true);
    try {
      const n = await convertAudioToKeyframesEdit(nodeId, options);
      useUIStore.getState().notify(
        n > 0
          ? {
              level: 'success',
              message: n === 1
                ? t('inspector.audioControls.convertedOne', 'Audio → {n} keyframe on “{track}”', { n, track: AUDIO_AMPLITUDE_PROP })
                : t('inspector.audioControls.convertedOther', 'Audio → {n} keyframes on “{track}”', { n, track: AUDIO_AMPLITUDE_PROP }),
              durationMs: 3200,
            }
          : {
              level: 'warning',
              message: t('inspector.audioControls.noDecode', 'No audio could be decoded for this layer.'),
              durationMs: 3200,
            },
      );
      if (n > 0) setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const convertDesc = tAround(t('inspector.audioControls.convertDesc', 'Samples the layer’s loudness into a {track} track (0–100) you can drive any property from. Replaces the existing track.', { track: SLOT }));

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      placement="bottom-end"
      trigger={
        <button
          type="button"
          className={toolStyles.toolButton}
          title={t('inspector.audioControls.convertTip', 'Write the loudness envelope as keyframes ({track}, 0–100) — drive any property from it', { track: AUDIO_AMPLITUDE_PROP })}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
        >
          <Icon name="keyframe" size="sm" />
          <span>{t('inspector.audioControls.convertMenu', 'Convert audio to keyframes…')}</span>
        </button>
      }
    >
      <div className={styles.panel}>
        <div className={styles.panelTitle}>{t('inspector.audioControls.convertTitle', 'Convert audio to keyframes')}</div>
        <p className={styles.panelDesc}>
          {convertDesc[0]}<code>{AUDIO_AMPLITUDE_PROP}</code>{convertDesc[1]}
        </p>

        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t('inspector.audioControls.detail', 'Detail')}</span>
          <div className={styles.segmented} role="radiogroup" aria-label={t('inspector.audioControls.keyframeDetail', 'Keyframe detail')}>
            {DETAIL_PRESETS.map((d) => (
              <button
                key={d.id}
                type="button"
                role="radio"
                aria-checked={detail === d.id}
                className={detail === d.id ? styles.segOn : styles.seg}
                onClick={() => setDetail(d.id)}
              >
                {detailLabel(d.id)}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t('inspector.audioControls.smoothing', 'Smoothing')}</span>
          <div className={styles.levelRow}>
            <Slider value={smoothing} min={1} max={31} step={2} onChange={setSmoothing} aria-label={t('inspector.audioControls.smoothing', 'Smoothing')} />
            <span className={styles.levelVal}>{smoothing === 1 ? t('inspector.audioControls.off', 'off') : `${smoothing}f`}</span>
          </div>
        </div>

        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t('inspector.audioControls.gain', 'Gain')}</span>
          <div className={styles.levelRow}>
            <Slider value={gain} min={0.25} max={4} step={0.25} onChange={setGain} aria-label={t('inspector.audioControls.amplitudeGain', 'Amplitude gain')} />
            <span className={styles.levelVal}>{gain}×</span>
          </div>
        </div>

        <div className={styles.estimate}>
          {decoding ? (
            <>{t('inspector.audioControls.decodingAudio', 'Decoding audio…')}</>
          ) : estimate === null ? (
            <>&nbsp;</>
          ) : estimate === 0 ? (
            <span className={styles.warn}>{t('inspector.audioControls.noAudio', 'No audio to convert.')}</span>
          ) : (
            <>
              <strong>{estimate.toLocaleString()}</strong>{' '}{estimate === 1 ? t('inspector.audioControls.keyframeWordOne', 'keyframe') : t('inspector.audioControls.keyframeWordOther', 'keyframes')}
              {estimate > 2000 ? <span className={styles.warn}> {t('inspector.audioControls.tryCoarser', '— try a coarser detail')}</span> : null}
            </>
          )}
        </div>

        <div className={styles.panelActions}>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            {t('inspector.audioControls.cancel', 'Cancel')}
          </Button>
          <Button size="sm" variant="primary" loading={busy} disabled={busy || estimate === 0} onClick={() => void apply()}>
            {busy ? t('inspector.audioControls.converting', 'Converting…') : t('inspector.audioControls.convert', 'Convert')}
          </Button>
        </div>
      </div>
    </Popover>
  );
}

export default AudioControls;
