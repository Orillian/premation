/**
 * The Audio panel — After Effects' Ctrl+4, on the approved 2026-10-19 sheet:
 * an identity row naming the layer the faders edit, then a mixer deck where
 * each channel is ONE column — its meter beside its fader on one dB axis,
 * the clip LED above, the channel's level under — then the pan and the two
 * fades as rows.
 *
 * What makes this a panel rather than a fourth VU meter: **the faders edit the
 * selected layer.** The three meters this app already had (`InfoAudioPanel`,
 * `PreviewPanel`, the status-bar `VUMeter`) all monitor the master bus and none
 * of them can change a level, so "the mix is too loud" had no control anywhere
 * near the thing measuring it. Here the meter and the fader that fixes what it
 * shows are the same six inches of screen.
 *
 * ## Two faders, one dB property and one pan
 *
 * AE draws an L and an R fader and calls the pair "Audio Levels". We store a
 * single `audioLevelDb` plus `audioPan`, and derive the two fader positions
 * from them. That is a deliberate schema choice, not an approximation:
 *
 *  - Both halves stay SCALAR, so they keyframe, graph-edit, and ride the
 *    existing ramp builder that keeps preview and export identical. A
 *    two-component property would need its own sampling path, and the graph
 *    editor could not draw it.
 *  - It gives us a real per-layer Pan, which the app did not have at all —
 *    panning previously meant applying the Stereo Mixer *effect*.
 *  - Independent L/R trims are exactly a level plus a balance, so nothing the
 *    two AE faders can express is lost.
 *
 * Dragging one fader moves level and pan together; the arithmetic and its
 * inverse live in `faderMath.ts`, tested there. The Pan row writes the pan
 * alone.
 *
 * ## Units and floor
 *
 * AE's Audio panel menu offers Units (decibels / percent) and a Slider Minimum.
 * Both are here — in this panel's ≡ menu, as AE keeps them (2026-10; they were
 * a popover under an in-panel title) — and both are per-user view settings
 * rather than document state: they change how a number is spelled, never what
 * is stored.
 */

import { t } from '@core/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorTrackWatch } from '@hooks/useMirror';
import { isTrackAnimated, readTrack } from '@core/mirror/selection';
import { audioEngine } from '@core/audio/AudioEngine';
import { toDb, meterFraction } from '@core/audio/audioLevels';
import {
  AUDIO_LEVEL_DB_PROP, AUDIO_PAN_PROP,
  MAX_LEVEL_DB, MIN_PAN, MAX_PAN,
} from '@core/audio/audioParams';
import { DEFAULT_FADE_SEC } from '@core/audio/audioFades';
import { LABEL_COLORS } from '@core/scene/labelColor';
import { useEngineEdit } from './useEngineEdit';
import { valueCommands } from './inspectorEdits';
import { fadeEdit } from './audioEdits';
import { channelDb, fromChannelDb, CLIP_DB } from './faderMath';
import { Icon } from '@components/Icon';
import { useDockPanelHeader } from '@components/DockPanel';
import type { DropdownItem } from '@components/Dropdown';
import { cn } from '@utils/cn';
import styles from './AudioPanel.module.css';

/** Meter refresh. 30 Hz is smooth to the eye and a third of the work of 90. */
const METER_HZ = 30;
/** How long a clip indicator stays lit after the peak that set it. */
const CLIP_HOLD_MS = 2000;
/** How long the peak-hold tick sits before it starts falling. */
const PEAK_HOLD_MS = 1200;

type Units = 'db' | 'percent';

const AUDIO_TRACKS = [AUDIO_LEVEL_DB_PROP, AUDIO_PAN_PROP] as const;

/** The Slider Minimum choices, AE's. */
const FLOORS_DB: readonly number[] = [-96, -72, -48, -24, -12];

/**
 * The Audio panel's ≡ rows — AE's Audio Options: Units and Slider Minimum, each
 * a submenu whose current choice is ticked (a radio set: picking the ticked row
 * keeps it).
 */
export function audioOptionsMenuRows(
  units: Units,
  floorDb: number,
  setUnits: (u: Units) => void,
  setFloorDb: (db: number) => void,
): DropdownItem[] {
  return [
    {
      type: 'item',
      id: 'audio-units',
      label: t('inspector.audioPanel.units', 'Units'),
      submenu: [
        { type: 'checkbox', id: 'audio-units-db', label: t('inspector.audioPanel.decibels', 'Decibels'), checked: units === 'db', onChange: () => setUnits('db') },
        { type: 'checkbox', id: 'audio-units-percent', label: t('inspector.audioPanel.percentage', 'Percentage'), checked: units === 'percent', onChange: () => setUnits('percent') },
      ],
    },
    {
      type: 'item',
      id: 'audio-slider-minimum',
      label: t('inspector.audioPanel.sliderMinimum', 'Slider Minimum'),
      submenu: FLOORS_DB.map((db): DropdownItem => ({
        type: 'checkbox',
        id: `audio-floor-${-db}`,
        label: t('inspector.audioPanel.dbValue', '{db} dB', { db }),
        checked: floorDb === db,
        onChange: () => setFloorDb(db),
      })),
    },
  ];
}

interface Target {
  nodeId: string;
  name: string;
  kind: 'audio' | 'video';
  /** The layer's label colour, or undefined when it has none. */
  labelColor: string | undefined;
  levelDb: number;
  pan: number;
  levelAnimated: boolean;
  panAnimated: boolean;
}

/**
 * The selected layer that makes a sound, resolved to what the faders need.
 *
 * `compSec` matters once a property is ANIMATED: the fader has to show the value
 * at the playhead, not the static base underneath the track. Without it the
 * panel and the inspector's own Level row disagreed — mid-fade the row read
 * −60 dB while the fader sat at 0 — which is the fastest way to make a user
 * stop trusting a mixer. Found by walking the app with a real clip; no unit test
 * would have noticed, because both halves were individually correct.
 */
function readTarget(nodeId: string | undefined, compSec: number): Target | null {
  if (!nodeId) return null;
  const m = documentMirror();
  const layer = m.layer(nodeId);
  if (!layer || (layer.kind !== 'audio' && layer.kind !== 'video')) return null;
  // `audio/levels` is dB with the legacy percent (`__level` / `audioLevel`)
  // already folded in by the engine; `audio/pan` is 0 when centred (absent).
  // Both are sampled in COMP time by the engine, which applies the layer's
  // retime — the same axis `KeyframeRow` shows.
  const levelDb = readTrack(m, nodeId, AUDIO_LEVEL_DB_PROP, compSec);
  const pan = readTrack(m, nodeId, AUDIO_PAN_PROP, compSec);
  if (levelDb === undefined || pan === undefined) return null;
  const sw = layer.switches;
  return {
    nodeId,
    name: layer.name,
    kind: layer.kind,
    labelColor: sw.labelColor ?? (sw.label > 0 ? LABEL_COLORS[sw.label - 1]?.color : undefined),
    levelDb,
    pan,
    levelAnimated: isTrackAnimated(m, nodeId, AUDIO_LEVEL_DB_PROP),
    panAnimated: isTrackAnimated(m, nodeId, AUDIO_PAN_PROP),
  };
}

export function AudioPanel(): JSX.Element {
  const selectedIds = useSelectionStore((s) => s.ids);
  // The faders read the selection's Level / Pan (and each layer's kind).
  useMirrorTrackWatch(selectedIds, AUDIO_TRACKS);
  const time = useActiveWorkspace()?.time ?? 0;
  const autoKeyframe = usePreferenceStore((s) => s.timelineAutoKeyframe);

  const [units, setUnits] = useState<Units>('db');
  const [floorDb, setFloorDb] = useState(-48);

  // AE's Audio Options, in this panel's ≡ menu. Memoised: handing the dock a
  // fresh array per render is the v0.8.1 update loop (PropertiesPanel).
  const optionsMenu = useMemo(() => audioOptionsMenuRows(units, floorDb, setUnits, setFloorDb), [units, floorDb]);
  const setCustomMenuItems = useDockPanelHeader()?.setCustomMenuItems;
  useEffect(() => {
    if (!setCustomMenuItems) return;
    setCustomMenuItems(optionsMenu);
    return () => setCustomMenuItems([]);
  }, [setCustomMenuItems, optionsMenu]);

  // ── The master meter ──────────────────────────────────────────────
  const [bars, setBars] = useState({ l: 0, r: 0 });
  const [peaks, setPeaks] = useState({ l: 0, r: 0 });
  const [clipped, setClipped] = useState({ l: 0, r: 0 });
  const peakAt = useRef({ l: 0, r: 0 });

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick);
      if (now - last < 1000 / METER_HZ) return;
      last = now;
      const lv = audioEngine.getLevels();
      if (!lv) {
        setBars({ l: 0, r: 0 });
        return;
      }
      const l = meterFraction(toDb(lv.l.rms), floorDb);
      const r = meterFraction(toDb(lv.r.rms), floorDb);
      setBars({ l, r });
      // Peak hold: the tick jumps up instantly and decays only after it has
      // sat still long enough to be read. A meter whose peak falls at the same
      // rate as the bar shows nothing the bar did not already show.
      setPeaks((prev) => {
        const next = { ...prev };
        for (const ch of ['l', 'r'] as const) {
          const v = ch === 'l' ? l : r;
          if (v >= prev[ch]) {
            next[ch] = v;
            peakAt.current[ch] = now;
          } else if (now - peakAt.current[ch] > PEAK_HOLD_MS) {
            next[ch] = Math.max(v, prev[ch] - 0.01);
          }
        }
        return next;
      });
      // Clipping is judged on absolute PEAK, not RMS — a single sample over
      // full scale is a clip, and RMS would never see it.
      setClipped((prev) => {
        const next = { ...prev };
        if (toDb(lv.l.peak) >= CLIP_DB) next.l = now;
        if (toDb(lv.r.peak) >= CLIP_DB) next.r = now;
        return next;
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [floorDb]);

  const now = performance.now();
  const clipLit = { l: now - clipped.l < CLIP_HOLD_MS, r: now - clipped.r < CLIP_HOLD_MS };

  // ── The selected layer ────────────────────────────────────────────
  const target = readTarget(selectedIds.find((id) => readTarget(id, time) !== null), time);

  // A fader drag is ONE gesture (pointer down → up): every move sends the
  // absolute level + pan for the pointer; a keyboard step is one entry. A key
  // lands at the playhead on an animated property or under Auto-Keyframe; a
  // centred pan is stored as ABSENT by the engine (`panOf`).
  const faderEdit = useEngineEdit();

  /** Move one fader: solve back to a (level, pan) pair and write both. */
  const setChannel = (ch: 'l' | 'r', db: number): void => {
    if (!target) return;
    const other = channelDb(target.levelDb, target.pan, ch === 'l' ? 'r' : 'l');
    const next = fromChannelDb(ch === 'l' ? db : other, ch === 'l' ? other : db);
    const values: Record<string, number> = { [AUDIO_LEVEL_DB_PROP]: next.levelDb };
    if (next.pan !== target.pan) values[AUDIO_PAN_PROP] = next.pan;
    faderEdit.send('Set Audio Levels', valueCommands([{ nodeId: target.nodeId, values }], { seconds: time, autoKeyframe }));
  };

  /** The Pan row: the balance alone, the level untouched. */
  const setPan = (pan: number): void => {
    if (!target) return;
    faderEdit.send('Set Audio Pan', valueCommands([{ nodeId: target.nodeId, values: { [AUDIO_PAN_PROP]: pan } }], { seconds: time, autoKeyframe }));
  };

  const fmt = (db: number): string =>
    units === 'db'
      // `+ 0` collapses negative zero: an equal-power channel lands a hair
      // under unity, and `(-0).toFixed(1)` spells that "-0.0 dB", which reads
      // as an attenuation that is not there.
      ? `${db > 0 ? '+' : ''}${(db + 0).toFixed(1).replace(/^-0\.0$/, '0.0')} dB`
      // AE's own mapping: 100% is 0 dB.
      : `${Math.round(Math.pow(10, db / 20) * 100)}%`;

  const lDb = target ? channelDb(target.levelDb, target.pan, 'l') : 0;
  const rDb = target ? channelDb(target.levelDb, target.pan, 'r') : 0;
  const panText = !target ? '—' : target.pan === 0
    ? t('inspector.audioPanel.panCentre', 'C')
    : target.pan < 0
      ? t('inspector.audioPanel.panLeft', '{n} L', { n: Math.abs(Math.round(target.pan)) })
      : t('inspector.audioPanel.panRight', '{n} R', { n: Math.abs(Math.round(target.pan)) });

  return (
    <div className={styles.root}>
      {/* No title (the tab is the panel's only one) and no options popover —
          Units and Slider Minimum are the ≡ menu's (`audioOptionsMenuRows`).
          The pointer readout that sat here is the Info panel's again. */}

      {/* ── Identity: which layer the faders edit ─────────────────── */}
      <div className={styles.identity} aria-label={t('inspector.audioPanel.audioLayer', 'Audio layer')}>
        <span className={styles.labelDot} style={target?.labelColor ? { background: target.labelColor } : undefined} aria-hidden />
        <Icon name={target?.kind === 'video' ? 'video' : 'audio'} size="sm" className={styles.kindIcon} />
        <span className={styles.name}>{target ? target.name : t('inspector.audioPanel.noLayer', 'No layer with sound selected')}</span>
        <span className={styles.kind}>{target ? (target.kind === 'video' ? t('inspector.audioPanel.videoLayerKind', 'Video layer') : t('inspector.audioPanel.audioLayer', 'Audio layer')) : ''}</span>
      </div>

      {/* ── Meter + faders, each channel one column, one dB scale ─── */}
      <div className={cn(styles.deck, !target && styles.deckIdle)}>
        <div className={styles.scale} aria-hidden="true">
          {scaleMarks(floorDb).map((db) => (
            <span key={db} style={{ bottom: `${meterFraction(db, floorDb) * 100}%` }}>{db > 0 ? `+${db}` : db}</span>
          ))}
        </div>

        {(['l', 'r'] as const).map((ch) => (
          <div key={ch} className={styles.strip}>
            <div
              className={cn(styles.clipLed, clipLit[ch] && styles.clipLedOn)}
              title={clipLit[ch] ? t('inspector.audioPanel.clipped', 'Clipped — the signal went over full scale') : t('inspector.audioPanel.noClipping', 'No clipping')}
              aria-label={clipLit[ch] ? t('inspector.audioPanel.chClipped', '{ch} clipped', { ch: ch.toUpperCase() }) : t('inspector.audioPanel.chNotClipping', '{ch} not clipping', { ch: ch.toUpperCase() })}
            />
            <div className={styles.meterWrap} {...faderEdit.press('Set Audio Levels', () => target !== null)}>
              <div className={styles.meterBar}>
                <div className={styles.meterFill} style={{ height: `${bars[ch] * 100}%` }} />
                <div className={styles.peakTick} style={{ bottom: `${peaks[ch] * 100}%` }} />
              </div>
              <input
                className={styles.fader}
                type="range"
                // Firefox's legacy vertical-range opt-in. Not in React's typed
                // attribute set, hence the escape hatch; the CSS
                // `writing-mode` handles every other engine.
                {...{ orient: 'vertical' }}
                min={floorDb}
                max={MAX_LEVEL_DB}
                step={0.5}
                value={Math.max(floorDb, Math.min(MAX_LEVEL_DB, ch === 'l' ? lDb : rDb))}
                disabled={!target}
                onChange={(e) => setChannel(ch, Number(e.currentTarget.value))}
                aria-label={ch === 'l' ? t('inspector.audioPanel.leftLevel', 'Left level') : t('inspector.audioPanel.rightLevel', 'Right level')}
              />
            </div>
            <div className={styles.chRow}>
              <span className={styles.chLabel}>{ch.toUpperCase()}</span>
              <span className={styles.chValue} data-numeric>{target ? fmt(ch === 'l' ? lDb : rDb) : '—'}</span>
            </div>
          </div>
        ))}
      </div>

      {/* ── Pan ───────────────────────────────────────────────────── */}
      <div className={styles.panRow} {...faderEdit.press('Set Audio Pan', () => target !== null)}>
        <span className={styles.rowLabel}>{t('inspector.audioPanel.pan', 'Pan')}</span>
        <input
          className={styles.pan}
          type="range"
          min={MIN_PAN}
          max={MAX_PAN}
          step={1}
          value={target ? target.pan : 0}
          disabled={!target}
          onChange={(e) => setPan(Number(e.currentTarget.value))}
          onDoubleClick={() => setPan(0)}
          aria-label={t('inspector.audioPanel.pan', 'Pan')}
          title={t('inspector.audioPanel.panTip', 'Pan — drag left or right, double-click to centre')}
        />
        <span className={styles.panValue} data-numeric>{panText}</span>
      </div>

      {/* ── Fades: one press each, the ramp length written on the field ── */}
      <div className={styles.fades}>
        <button
          type="button"
          className={styles.fadeField}
          disabled={!target}
          onClick={() => { if (target) void fadeEdit([target.nodeId], 'in'); }}
          title={t('inspector.audioPanel.fadeInTip', 'Ramp up from silence over {sec}s', { sec: DEFAULT_FADE_SEC })}
        >
          <span className={styles.rowLabel}>{t('inspector.audioPanel.fadeIn', 'Fade In')}</span>
          <span className={styles.fadeValue} data-numeric>{DEFAULT_FADE_SEC.toFixed(2)}</span>
          <span className={styles.unit}>s</span>
        </button>
        <button
          type="button"
          className={styles.fadeField}
          disabled={!target}
          onClick={() => { if (target) void fadeEdit([target.nodeId], 'out'); }}
          title={t('inspector.audioPanel.fadeOutTip', 'Ramp down to silence over {sec}s', { sec: DEFAULT_FADE_SEC })}
        >
          <span className={styles.rowLabel}>{t('inspector.audioPanel.fadeOut', 'Fade Out')}</span>
          <span className={styles.fadeValue} data-numeric>{DEFAULT_FADE_SEC.toFixed(2)}</span>
          <span className={styles.unit}>s</span>
        </button>
      </div>

      {target ? (
        (target.levelAnimated || target.panAnimated) && (
          <p className={styles.note} role="status">
            {target.levelAnimated && target.panAnimated
              ? t('inspector.audioPanel.bothKeyframed', 'Level and pan are keyframed — a fader move keys at the playhead.')
              : target.levelAnimated
                ? t('inspector.audioPanel.levelKeyframed', 'Level is keyframed — a fader move keys at the playhead.')
                : t('inspector.audioPanel.panKeyframed', 'Pan is keyframed — a fader move keys at the playhead.')}
          </p>
        )
      ) : (
        <p className={styles.note}>{t('inspector.audioPanel.selectHint', 'Select a layer with sound to set its level and pan.')}</p>
      )}
    </div>
  );
}

/** The dB gridlines that fit the chosen floor without crowding. Nothing
 *  above 0: the meter pins everything over unity to its top (`meterFraction`),
 *  so +6 and +12 would land on the 0 mark. */
function scaleMarks(floorDb: number): number[] {
  const all = [0, -6, -12, -24, -36, -48, -72, -96];
  return all.filter((db) => db >= floorDb);
}
