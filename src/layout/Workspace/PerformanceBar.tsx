/**
 * The Performance bar (docs/PERFORMANCE_ANIMATION_PLAN.md §10): one slim bar
 * along the bottom of the viewport while a layer is armed for recording.
 *
 *   ● Ready — drag the layer   Shape 1 · Position   Perform | Pose   100% ▾   Detail ━━●━━   ⋯   ✕
 *
 * Nothing modal and nothing over the picture's centre. While a take records,
 * every control but the status is disabled and the clock runs (written to the
 * DOM from a store subscription — no React render per played frame).
 *
 * The bar reads performanceStore and the preferences; every action is the
 * session's (providers/commands/performanceSession.ts).
 */

import { useEffect, useRef } from 'react';
import { usePerformanceStore, type PerformanceTarget } from '@stores/performanceStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { usePlaybackClockStore } from '@stores/playbackClockStore';
import { useProjectStore } from '@stores/projectStore';
import { useMirror } from '@hooks/useMirror';
import {
  adjustTakeDetail,
  closePerformance,
  recordAgain,
  setPerformanceMode,
  setPerformanceTarget,
  setPoseKey,
  takeIsAdjustable,
  targetLabel,
} from '@providers/commands/performanceSession';
import { Button } from '@components/Button';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { Icon } from '@components/Icon';
import { IconButton } from '@components/IconButton';
import { Kbd } from '@components/Kbd';
import { Popover } from '@components/Popover';
import { Segmented } from '@components/Segmented';
import { Slider } from '@components/Slider';
import { Switch } from '@components/Switch';
import { Tooltip, TooltipProvider } from '@components/Tooltip';
import { t } from '@core/i18n';
import { cn } from '@utils/cn';
import styles from './PerformanceBar.module.css';

const SPEEDS = [25, 50, 100, 200] as const;
const POSE_STEPS = [1, 2, 5, 10, 12, 24] as const;
const TARGETS: readonly PerformanceTarget[] = ['position', 'rotation', 'scale', 'opacity'];

function formatClock(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(2).padStart(5, '0')}`;
}

/** The take's running time, written straight to the DOM on each clock tick. */
function TakeClock({ start }: { start: number }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const write = (): void => {
      const tab = useProjectStore.getState().activeTabId ?? '';
      const now = usePlaybackClockStore.getState().clocks[tab]?.time ?? start;
      if (ref.current) ref.current.textContent = formatClock(now - start);
    };
    write();
    return usePlaybackClockStore.subscribe(write);
  }, [start]);
  return <span ref={ref} className={styles.clock} data-take-clock="" />;
}

function SettingsPopover({ disabled }: { disabled: boolean }): JSX.Element {
  const reduction = usePreferenceStore((s) => s.performanceReduction);
  const wholeFrames = usePreferenceStore((s) => s.performanceWholeFrames);
  const preRoll = usePreferenceStore((s) => s.performancePreRoll);
  const hold = usePreferenceStore((s) => s.performanceHoldSeconds);
  const setPref = usePreferenceStore((s) => s.set);
  return (
    <Popover
      placement="top-end"
      trigger={(
        <IconButton size="xs" disabled={disabled} aria-label={t('performance.settings', 'Recording settings')}>
          <Icon name="more-horizontal" size="sm" />
        </IconButton>
      )}
    >
      <div className={styles.settings} data-performance-bar="">
        <div className={styles.settingRow}>
          <span className={styles.settingLabel}>{t('performance.reduction', 'Keyframes')}</span>
          <Segmented
            size="sm"
            value={reduction}
            onChange={(v) => setPref('performanceReduction', v)}
            options={[
              { value: 'smart', label: t('performance.reduction.smart', 'Smart') },
              { value: 'everyFrame', label: t('performance.reduction.everyFrame', 'Every frame') },
              { value: 'smooth', label: t('performance.reduction.smooth', 'Smooth') },
            ]}
          />
        </div>
        <p className={styles.settingHelp}>
          {reduction === 'smart'
            ? t('performance.reduction.smartHelp', 'Few keys with eases and path handles; pauses stay pauses.')
            : reduction === 'everyFrame'
              ? t('performance.reduction.everyFrameHelp', 'One key per captured sample — After Effects’ Motion Sketch.')
              : t('performance.reduction.smoothHelp', 'Simplifies the drawn path; pauses along a straight line are not kept.')}
        </p>
        <div className={styles.settingRow}>
          <span className={styles.settingLabel}>{t('performance.wholeFrames', 'Keys on whole frames')}</span>
          <Switch
            checked={wholeFrames}
            disabled={reduction !== 'smart'}
            onChange={(e) => setPref('performanceWholeFrames', e.target.checked)}
            aria-label={t('performance.wholeFrames', 'Keys on whole frames')}
          />
        </div>
        <div className={styles.settingRow}>
          <span className={styles.settingLabel}>{t('performance.preRoll', 'Pre-roll')}</span>
          <Segmented
            size="sm"
            value={String(preRoll) as '0' | '1' | '2'}
            onChange={(v) => setPref('performancePreRoll', Number(v))}
            options={[
              { value: '0', label: t('performance.preRoll.off', 'Off') },
              { value: '1', label: '1 s' },
              { value: '2', label: '2 s' },
            ]}
          />
        </div>
        <div className={styles.settingRow}>
          <span className={styles.settingLabel}>{t('performance.hold', 'Hold after')}</span>
          <Slider
            size="sm"
            min={0.1}
            max={1}
            step={0.05}
            value={hold}
            disabled={reduction !== 'smart'}
            showValue
            onChange={(v) => setPref('performanceHoldSeconds', v)}
            className={styles.settingSlider}
          />
        </div>
      </div>
    </Popover>
  );
}

export function PerformanceBar(): JSX.Element | null {
  const phase = usePerformanceStore((s) => s.phase);
  const nodeId = usePerformanceStore((s) => s.nodeId);
  const target = usePerformanceStore((s) => s.target);
  const takeStart = usePerformanceStore((s) => s.takeStart);
  const lastKeys = usePerformanceStore((s) => s.lastKeys);
  const poseKeys = usePerformanceStore((s) => s.poseKeys);
  const mode = usePreferenceStore((s) => s.performanceMode);
  const speed = usePreferenceStore((s) => s.performanceCaptureSpeed);
  const detail = usePreferenceStore((s) => s.performanceDetail);
  const reduction = usePreferenceStore((s) => s.performanceReduction);
  const poseStep = usePreferenceStore((s) => s.performancePoseStep);
  const poseUnit = usePreferenceStore((s) => s.performancePoseStepUnit);
  const setPref = usePreferenceStore((s) => s.set);
  const mirror = useMirror();

  if (phase === 'off' || !nodeId) return null;
  const recording = phase === 'recording';
  const perform = mode === 'perform';
  const layerName = mirror.layer(nodeId)?.name ?? t('performance.layer', 'Layer');
  const scrub = perform && target !== 'position';

  const status = recording
    ? t('performance.status.recording', 'Recording')
    : phase === 'done' && perform
      ? t('performance.status.keys', '{n} keys', { n: lastKeys })
      : perform
        ? scrub
          ? t('performance.status.readyScrub', 'Ready — drag left or right')
          : t('performance.status.ready', 'Ready — drag the layer')
        : poseKeys > 0
          ? t('performance.status.poseKeys', '{n} poses set', { n: poseKeys })
          : t('performance.status.pose', 'Move the layer, then Set Key');

  const targetItems = (): DropdownItem[] => TARGETS.map((tg) => ({
    type: 'item',
    id: tg,
    label: targetLabel(tg),
    ...(tg === target ? { icon: 'check' as const } : {}),
    onSelect: () => setPerformanceTarget(tg),
  }));
  const speedItems = (): DropdownItem[] => SPEEDS.map((sp) => ({
    type: 'item',
    id: String(sp),
    label: `${sp}%`,
    ...(sp === speed ? { icon: 'check' as const } : {}),
    onSelect: () => setPref('performanceCaptureSpeed', sp),
  }));
  const stepItems = (): DropdownItem[] => [
    ...POSE_STEPS.map((n): DropdownItem => ({
      type: 'item',
      id: `f${n}`,
      label: t('performance.step.frames', '{n} frames', { n }),
      ...(poseUnit === 'frames' && poseStep === n ? { icon: 'check' as const } : {}),
      onSelect: () => { setPref('performancePoseStepUnit', 'frames'); setPref('performancePoseStep', n); },
    })),
    { type: 'separator' },
    ...[0.5, 1, 2].map((n): DropdownItem => ({
      type: 'item',
      id: `s${n}`,
      label: t('performance.step.seconds', '{n} s', { n }),
      ...(poseUnit === 'seconds' && poseStep === n ? { icon: 'check' as const } : {}),
      onSelect: () => { setPref('performancePoseStepUnit', 'seconds'); setPref('performancePoseStep', n); },
    })),
  ];
  const stepLabel = poseUnit === 'seconds'
    ? t('performance.step.seconds', '{n} s', { n: poseStep })
    : t('performance.step.framesShort', '{n}f', { n: poseStep });
  const adjustable = phase === 'done' && perform && reduction === 'smart' && takeIsAdjustable();

  return (
    <TooltipProvider>
      <div
        className={styles.bar}
        data-performance-bar=""
        data-phase={phase}
        role="toolbar"
        aria-label={t('performance.bar', 'Performance recording')}
      >
        <span className={cn(styles.dot, recording && styles.dotLive, phase === 'done' && styles.dotDone)} aria-hidden />
        <span className={styles.status} aria-live="polite">
          {status}
          {recording && <TakeClock start={takeStart} />}
        </span>

        <span className={styles.divider} />

        <Dropdown
          placement="top-start"
          items={targetItems}
          trigger={(
            <Button size="xs" variant="ghost" disabled={recording} className={styles.chipTrigger}>
              <span className={styles.chipLayer}>{layerName}</span>
              <span className={styles.chipProp}>{targetLabel(target)}</span>
              <Icon name="chevron-down" size={12} />
            </Button>
          )}
        />

        <Segmented
          size="sm"
          value={mode}
          disabled={recording}
          onChange={setPerformanceMode}
          options={[
            { value: 'perform', label: t('performance.mode.perform', 'Perform') },
            { value: 'pose', label: t('performance.mode.pose', 'Pose') },
          ]}
        />

        {perform ? (
          <Tooltip label={t('performance.speedHelp', 'Capture speed: 50% plays back twice as long as you drew it')}>
            <span>
              <Dropdown
                placement="top-start"
                items={speedItems}
                trigger={(
                  <Button size="xs" variant="secondary" disabled={recording} className={styles.numeric}>
                    <span>{`${speed}%`}</span>
                    <Icon name="chevron-down" size={12} />
                  </Button>
                )}
              />
            </span>
          </Tooltip>
        ) : (
          <>
            <Button size="xs" variant="secondary" onClick={() => void setPoseKey()}>
              <Icon name="keyframe" size="sm" />
              <span>{t('performance.setKey', 'Set Key')}</span>
              <Kbd chord="Enter" size="sm" />
            </Button>
            <Tooltip label={t('performance.stepHelp', 'How far the playhead moves after each key')}>
              <span>
                <Dropdown
                  placement="top-start"
                  items={stepItems}
                  trigger={(
                    <Button size="xs" variant="secondary" className={styles.numeric}>
                      <span>{t('performance.step', 'Step {step}', { step: stepLabel })}</span>
                      <Icon name="chevron-down" size={12} />
                    </Button>
                  )}
                />
              </span>
            </Tooltip>
          </>
        )}

        {perform && reduction === 'smart' && (
          <Tooltip label={adjustable
            ? t('performance.detailAdjust', 'Fewer keys ↔ more faithful — re-fits the take you just recorded')
            : t('performance.detailHelp', 'Fewer keys ↔ more faithful')}
          >
            <span className={styles.detail}>
              <span className={styles.detailLabel}>{t('performance.detail', 'Detail')}</span>
              <Slider
                size="sm"
                min={0}
                max={100}
                step={1}
                value={detail}
                disabled={recording}
                onChange={adjustTakeDetail}
                className={styles.detailSlider}
              />
            </span>
          </Tooltip>
        )}

        {phase === 'done' && perform && (
          <Button size="xs" variant="ghost" onClick={recordAgain}>
            <Icon name="refresh" size="sm" />
            <span>{t('performance.recordAgain', 'Record again')}</span>
          </Button>
        )}

        <span className={styles.spacer} />
        <span className={styles.hint}>
          {recording
            ? scrub
              ? t('performance.hint.recordingScrub', 'Shift for fine control · Release to finish · Esc to cancel')
              : t('performance.hint.recording', 'Release to finish · Esc to cancel')
            : t('performance.hint.close', 'Esc to close')}
        </span>
        <SettingsPopover disabled={recording} />
        <IconButton size="xs" disabled={recording} aria-label={t('performance.close', 'Close')} onClick={closePerformance}>
          <Icon name="close" size="sm" />
        </IconButton>
      </div>
    </TooltipProvider>
  );
}
