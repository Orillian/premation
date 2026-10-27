/**
 * Preview panel — After Effects' Preview panel (2026-10-21 redesign): the
 * timecode with the frame / rate / duration beside it and a playhead strip
 * under both, one transport row, then the preview settings as label +
 * segmented rows (every choice visible, one click), and the cache meter at
 * the foot.
 *
 * Only settings this app actually has, in AE's order — no stand-ins for AE's
 * Shortcut, Play From, Frame Rate or Full Screen, because a control that
 * changes nothing is worse than none:
 *   • Timecode   → the playhead, written by `LiveTimecode` (no React render per frame)
 *   • Transport  → TimelineController + projectStore (first / step / play / last, loop, audio)
 *   • Range      → the Work Area (Work Area / Entire Composition / From Current Time)
 *   • Cache first → Cache Before Playback (preference; `play { cacheFirst }`)
 *   • Step       → how far the step buttons move (1, 2, 3 or 6 frames)
 *   • Resolution → renderQualityStore (Auto adaptive / Full / Half / Third / Quarter)
 *   • Draft      → renderQualityStore draft flag (skips motion blur for 60fps scrub)
 *   • Cache      → the timeline's cache lane, as two fractions (RAM, disk)
 *
 * Nothing here follows the playhead through React: the step buttons read it
 * when pressed (`getTime`), the timecode is a text node and the playhead
 * strip a transform the playhead subscription rewrites, so playback renders
 * this panel not once per frame.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useProjectStore } from '@stores/projectStore';
import { getTime, setTime as setPlayheadTime } from '@stores/playbackClockStore';
import { useRenderQualityStore, resolutionChoiceOf, setResolutionChoice, type ResolutionChoice } from '@stores/renderQualityStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow, compFps, useActiveMirrorComp } from '@hooks/useMirror';
import { flicksToSeconds, type CompSettings } from '@motion/engine-api';
import { isTransportLooping, pauseTransport, playTransport, setTransportLooping } from '@core/timeline/timelineView';
import { edit } from '@core/engine/uiEdits';
import { compTime } from '@core/engine/propRefs';
import { audioEngine } from '@core/audio/AudioEngine';
import { framesToTimecode } from '@core/time/timecode';
import { t } from '@core/i18n';
import { cn } from '@utils/cn';
import { LiveTimecode } from '@layout/Timeline/LiveTimecode';
import { useLivePlayhead } from '@layout/Timeline/useLivePlayhead';
import { usePreviewCacheStats } from '@layout/Timeline/CacheActions';
import { Accordion, type AccordionItem } from '@components/Accordion';
import { Icon } from '@components/Icon';
import { IconButton } from '@components/IconButton';
import { Segmented, type SegmentedOption } from '@components/Segmented';
import { Switch } from '@components/Switch';
import styles from './PreviewPanel.module.css';

type PlayRange = 'work-area' | 'entire-comp' | 'current-forward';

function ranges(): ReadonlyArray<SegmentedOption<PlayRange>> {
  return [
    { value: 'work-area', label: t('inspector.preview.rangeWorkAreaShort', 'Work area') },
    { value: 'entire-comp', label: t('inspector.preview.rangeCompShort', 'Comp') },
    { value: 'current-forward', label: t('inspector.preview.rangeFromNowShort', 'From now') },
  ];
}

/** Frames the step buttons skip over (0 = the next frame), as option values. */
function steps(): ReadonlyArray<SegmentedOption<string>> {
  return [
    { value: '0', label: '1', ariaLabel: t('inspector.preview.stepOne', '1 frame') },
    { value: '1', label: '2', ariaLabel: t('inspector.preview.stepMany', '{n} frames', { n: 2 }) },
    { value: '2', label: '3', ariaLabel: t('inspector.preview.stepMany', '{n} frames', { n: 3 }) },
    { value: '5', label: '6', ariaLabel: t('inspector.preview.stepMany', '{n} frames', { n: 6 }) },
  ];
}

function resolutions(): ReadonlyArray<SegmentedOption<ResolutionChoice>> {
  return [
    { value: 'auto', label: t('inspector.preview.resAuto', 'Auto') },
    { value: '1', label: t('inspector.preview.resFull', 'Full') },
    { value: '2', label: '½', ariaLabel: t('inspector.preview.resHalf', 'Half') },
    { value: '3', label: '⅓', ariaLabel: t('inspector.preview.resThird', 'Third') },
    { value: '4', label: '¼', ariaLabel: t('inspector.preview.resQuarter', 'Quarter') },
  ];
}

export function PreviewPanel(): JSX.Element {
  const activeTabId = useProjectStore((s) => s.activeTabId);
  const playing = useProjectStore((s) => (activeTabId ? s.tabs[activeTabId]?.playing ?? false : false));
  const setPlaying = useProjectStore((s) => s.actions.setPlaying);

  const setTime = (t: number, frame: number): void => {
    if (activeTabId) setPlayheadTime(activeTabId, t, frame);
  };

  const comp = useActiveMirrorComp();
  // The rate as the settings dialog states it (NTSC 30000/1001 → 29.97), so
  // the frame maths match what the user typed.
  const fps = Number(compFps(comp).toFixed(3)) || 30;
  const duration = comp ? flicksToSeconds(comp.settings.duration) : 0;

  // Loop playback state (transport, not the document)
  const [looping, setLoopingState] = useState(() => isTransportLooping());
  useEffect(() => {
    setLoopingState(isTransportLooping());
  }, [activeTabId]);

  const setLooping = (on: boolean): void => {
    setTransportLooping(on);
    setLoopingState(on);
  };

  // Work area range
  const [range, setRangeState] = useState<PlayRange>(() =>
    hasWorkArea(activeSettingsNow()) ? 'work-area' : 'entire-comp',
  );
  const setRange = (next: PlayRange): void => {
    const compId = activeCompIdNow();
    const now = getTime();
    if (next === 'entire-comp') {
      if (compId && hasWorkArea(activeSettingsNow())) void edit('Clear Work Area', { type: 'clearWorkArea', comp: compId });
    } else if (next === 'current-forward' && duration > now && compId) {
      void edit('Work Area', { type: 'setWorkArea', comp: compId, range: { start: compTime(now), duration: compTime(duration - now) } });
    }
    setRangeState(next);
  };

  // Frames the step buttons skip
  const [skip, setSkip] = useState<number>(0);

  // Render resolution & adaptive quality
  const resolution = useRenderQualityStore((s) => s.resolution);
  const adaptive = useRenderQualityStore((s) => s.adaptive);
  const draft = useRenderQualityStore((s) => s.draft);
  const setDraft = useRenderQualityStore((s) => s.setDraft);

  const resolutionChoice: ResolutionChoice = resolutionChoiceOf({ adaptive, resolution });
  const cacheBeforePlayback = usePreferenceStore((s) => s.cacheBeforePlayback);

  // The playhead strip under the timecode: a transform the playhead
  // subscription writes, never a React render.
  const headRef = useRef<HTMLSpanElement | null>(null);
  const applyHead = useCallback((time: number): void => {
    const el = headRef.current;
    if (!el) return;
    const f = duration > 0 ? Math.min(1, Math.max(0, time / duration)) : 0;
    el.style.transform = `scaleX(${f})`;
  }, [duration]);
  useLivePlayhead(applyHead, !!activeTabId);

  // Audio in the preview (the master mute)
  const [muteAudio, setMuteAudioState] = useState(() => audioEngine.isMasterMuted());
  const setMuteAudio = (muted: boolean): void => {
    audioEngine.setMasterMuted(muted);
    setMuteAudioState(muted);
  };

  // The group rows remember their open state the way the Properties sections do.
  const groupsOpen = usePreferenceStore((s) => s.inspectorSections);
  const setPref = usePreferenceStore((s) => s.set);
  const toggleGroup = (id: string, open: boolean): void => {
    setPref('inspectorSections', { ...usePreferenceStore.getState().inspectorSections, [id]: open });
  };

  // The cache lane's two fractions, re-read at 2Hz while coverage changes.
  const { stats: cache } = usePreviewCacheStats();
  const ramPct = cache.total > 0 ? Math.round((cache.cached / cache.total) * 100) : 0;
  const diskPct = cache.total > 0 && cache.diskMb !== null ? Math.round((cache.onDisk / cache.total) * 100) : null;

  // Frame navigation handlers — the playhead is read when pressed, not rendered.
  const handleFirstFrame = (): void => {
    setTime(0, 0);
  };

  const handlePrevFrame = (): void => {
    const targetT = Math.max(0, getTime() - (skip + 1) / fps);
    setTime(targetT, Math.round(targetT * fps));
  };

  const handleTogglePlay = (): void => {
    const next = !playing;
    setPlaying(next);
    if (next) playTransport();
    else pauseTransport();
  };

  const handleNextFrame = (): void => {
    const targetT = Math.min(duration, getTime() + (skip + 1) / fps);
    setTime(targetT, Math.round(targetT * fps));
  };

  const handleLastFrame = (): void => {
    setTime(duration, Math.round(duration * fps));
  };

  const backTip = skip > 0
    ? t('inspector.preview.backMany', 'Back {n} frames (Page Up)', { n: skip + 1 })
    : t('inspector.preview.backOne', 'Back one frame (Page Up)');
  const forwardTip = skip > 0
    ? t('inspector.preview.forwardMany', 'Forward {n} frames (Page Down)', { n: skip + 1 })
    : t('inspector.preview.forwardOne', 'Forward one frame (Page Down)');

  const groups: AccordionItem[] = [
    {
      id: 'preview.playback',
      title: t('inspector.preview.playback', 'Playback'),
      defaultOpen: true,
      content: (
        <div className={styles.rows}>
          <div className={styles.row} title={t('inspector.preview.rangeTitle', 'What a preview plays — and loops')}>
            <span className={styles.label}>{t('inspector.preview.range', 'Range')}</span>
            <Segmented
              className={styles.seg}
              size="sm"
              fullWidth
              aria-label={t('inspector.preview.range', 'Range')}
              options={ranges()}
              value={range}
              onChange={setRange}
            />
          </div>
          <label className={styles.row} title={t('inspector.preview.cacheBeforeTitle', 'Render the range into the cache first, then play every frame on time')}>
            <span className={styles.label}>{t('inspector.preview.cacheBefore', 'Cache first')}</span>
            <span className={styles.switchRow}>
              <Switch
                aria-label={t('inspector.preview.cacheBeforeAria', 'Cache before playback')}
                checked={cacheBeforePlayback}
                onChange={(e) => usePreferenceStore.getState().set('cacheBeforePlayback', e.currentTarget.checked)}
              />
              <span className={styles.help}>{t('inspector.preview.cacheBeforeHelp', 'Off: play at once, skipping frames not ready')}</span>
            </span>
          </label>
          <div className={styles.row} title={t('inspector.preview.stepTitle', 'How far the previous and next frame buttons move')}>
            <span className={styles.label}>{t('inspector.preview.step', 'Step')}</span>
            <Segmented
              className={styles.seg}
              size="sm"
              fullWidth
              aria-label={t('inspector.preview.step', 'Step')}
              options={steps()}
              value={String(skip)}
              onChange={(v) => setSkip(Number(v))}
            />
          </div>
        </div>
      ),
    },
    {
      id: 'preview.quality',
      title: t('inspector.preview.quality', 'Quality'),
      defaultOpen: true,
      content: (
        <div className={styles.rows}>
          <div className={styles.row} title={t('inspector.preview.resolutionTitle', 'Pixels the viewer renders: Auto drops while a drag or playback cannot keep up')}>
            <span className={styles.label}>{t('inspector.preview.resolution', 'Resolution')}</span>
            <Segmented
              className={styles.seg}
              size="sm"
              fullWidth
              aria-label={t('inspector.preview.resolution', 'Resolution')}
              options={resolutions()}
              value={resolutionChoice}
              onChange={setResolutionChoice}
            />
          </div>
          <label className={styles.row}>
            <span className={styles.label}>{t('inspector.preview.draft', 'Draft')}</span>
            <span className={styles.switchRow}>
              <Switch
                aria-label={t('inspector.preview.draftAria', 'Draft quality')}
                checked={draft}
                title={draft ? t('inspector.preview.draftOn', 'Draft quality: on — motion blur skipped while previewing') : t('inspector.preview.draftOff', 'Draft quality: off')}
                onChange={(e) => setDraft(e.currentTarget.checked)}
              />
              <span className={styles.help}>{t('inspector.preview.draftHelpLong', 'Skip motion blur while previewing')}</span>
            </span>
          </label>
        </div>
      ),
    },
  ];

  return (
    <div className={styles.root}>
      <div className={styles.top}>
        {/* ── The timecode, with frame / rate / duration beside it ── */}
        <div className={styles.timecodeRow} aria-label={t('inspector.preview.currentTime', 'Current time')}>
          <span className={styles.timecode} data-numeric>
            {activeTabId
              ? <LiveTimecode fps={fps} />
              : framesToTimecode(0, fps)}
          </span>
          <span className={styles.timecodeMeta} data-numeric>
            <span>
              {t('inspector.preview.frameWord', 'frame')}{' '}
              {activeTabId ? <LiveTimecode fps={fps} format="frames" /> : '00000'}
            </span>
            <span>{fps.toFixed(2).replace(/\.00$/, '')} fps · {framesToTimecode(duration, fps)}</span>
          </span>
        </div>
        <div className={styles.headTrack} aria-hidden>
          <span ref={headRef} className={styles.headFill} />
        </div>

        {/* ── Transport: first, step back, play, step on, last · loop, audio ── */}
        <div className={styles.transport} role="toolbar" aria-label={t('inspector.preview.transportAria', 'Preview transport controls')}>
          <IconButton
            aria-label={t('inspector.preview.firstFrame', 'First frame (Home)')}
            tooltip={t('inspector.preview.firstFrame', 'First frame (Home)')}
            variant="ghost"
            size="sm"
            onClick={handleFirstFrame}
          >
            <Icon name="skip-back" size="sm" />
          </IconButton>

          <IconButton
            aria-label={t('inspector.preview.prevFrame', 'Previous frame')}
            tooltip={backTip}
            variant="ghost"
            size="sm"
            onClick={handlePrevFrame}
          >
            <Icon name="chevron-left" size="sm" />
          </IconButton>

          <IconButton
            aria-label={playing ? t('inspector.preview.pause', 'Pause') : t('inspector.preview.play', 'Play')}
            tooltip={playing ? t('inspector.preview.pauseTip', 'Pause playback (Space)') : t('inspector.preview.playTip', 'Play preview (Space)')}
            variant="ghost"
            size="md"
            className={styles.play}
            onClick={handleTogglePlay}
          >
            <Icon name={playing ? 'pause' : 'play'} size="md" />
          </IconButton>

          <IconButton
            aria-label={t('inspector.preview.nextFrame', 'Next frame')}
            tooltip={forwardTip}
            variant="ghost"
            size="sm"
            onClick={handleNextFrame}
          >
            <Icon name="chevron-right" size="sm" />
          </IconButton>

          <IconButton
            aria-label={t('inspector.preview.lastFrame', 'Last frame (End)')}
            tooltip={t('inspector.preview.lastFrame', 'Last frame (End)')}
            variant="ghost"
            size="sm"
            onClick={handleLastFrame}
          >
            <Icon name="skip-forward" size="sm" />
          </IconButton>

          <span className={styles.transportGap} aria-hidden />

          <IconButton
            className={styles.toggle}
            aria-label={looping ? t('inspector.preview.disableLoop', 'Disable loop') : t('inspector.preview.enableLoop', 'Enable loop')}
            tooltip={looping ? t('inspector.preview.loopOn', 'Loop: on') : t('inspector.preview.loopOff', 'Loop: off — play once')}
            variant="ghost"
            active={looping}
            aria-pressed={looping}
            size="sm"
            onClick={() => setLooping(!looping)}
          >
            <Icon name="loop" size="sm" />
          </IconButton>

          <IconButton
            className={styles.toggle}
            size="sm"
            variant="ghost"
            active={!muteAudio}
            aria-label={t('inspector.preview.includeAudio', 'Include audio')}
            aria-pressed={!muteAudio}
            tooltip={muteAudio ? t('inspector.preview.audioMuted', 'Audio: muted in previews') : t('inspector.preview.audioPlaying', 'Audio: playing in previews')}
            onClick={() => setMuteAudio(!muteAudio)}
          >
            <Icon name={muteAudio ? 'audio-off' : 'audio'} size="sm" />
          </IconButton>
        </div>
      </div>

      <Accordion className={styles.groups} items={groups} openOverrides={groupsOpen} onToggle={toggleGroup} />

      {/* ── The cache lane's meter: what will play in real time ── */}
      <div className={styles.cache} title={t('inspector.preview.cacheTitle', 'Preview cache — frames of the comp (or work area) held in memory and on disk')}>
        <div className={styles.cacheHead}>
          <span className={styles.label}>{t('inspector.preview.cache', 'Cache')}</span>
          <span className={styles.cacheLegend} data-numeric>
            {cache.total > 0 ? (
              <>
                <span className={styles.legendItem}>
                  <span className={cn(styles.dot, styles.dotRam)} aria-hidden />
                  {t('inspector.preview.cacheRamOnly', 'RAM {ram}%', { ram: ramPct })}
                </span>
                {diskPct !== null ? (
                  <span className={styles.legendItem}>
                    <span className={cn(styles.dot, styles.dotDisk)} aria-hidden />
                    {t('inspector.preview.cacheDiskOnly', 'Disk {disk}%', { disk: diskPct })}
                  </span>
                ) : null}
              </>
            ) : '—'}
          </span>
        </div>
        <div className={styles.cacheStrip} aria-hidden>
          <span className={styles.cacheRam} style={{ width: `${ramPct}%` }} />
          <span className={styles.cacheDisk} style={{ width: `${diskPct ?? 0}%` }} />
        </div>
      </div>
    </div>
  );
}

/** The active composition's settings, read at call time. */
function activeSettingsNow(): CompSettings | undefined {
  const id = activeCompIdNow();
  return id ? documentMirror().comp(id)?.settings : undefined;
}

/** Whether a work area is set: the API states "none" as the whole composition. */
function hasWorkArea(s: CompSettings | undefined): boolean {
  return !!s && !(s.workArea.start === 0 && s.workArea.duration === s.duration);
}

export default PreviewPanel;
