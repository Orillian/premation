/**
 * LoadingScreen — the editor's own ground with the mark, a 2px progress line
 * and the boot stage in words (bootStageStore), the version at the corner.
 *
 * It replaced a rotating rainbow border and a pulsing logo (2026-10-19): the
 * wait has real stages — the engine, the fonts, the plugins, the project —
 * and naming the one in progress reads as fast and honest where a spinner
 * reads as stuck. Before the boot reports a stage (the pre-boot routes, a
 * sign-in callback), the line sweeps and the message alone is shown.
 */

import { useEffect, useState } from 'react';
import { Logo } from '@components/Logo';
import { BOOT_STAGES, bootStageLabel, bootStageVerb, bootFraction, useBootStageStore } from '@stores/bootStageStore';
import { APP_VERSION } from '@core/config/appVersion';
import { cn } from '@utils/cn';
import { t } from '@core/i18n';
import styles from './LoadingScreen.module.css';

export interface LoadingScreenProps {
  message?: string;
  fullScreen?: boolean;
}

/** One line of advice under the stages, rotated per mount — never per frame. */
function tips(): string[] {
  return [
    t('ui.loadingScreen.tip.shortcuts', 'Shift+/ shows every shortcut'),
    t('ui.loadingScreen.tip.typeTool', 'Ctrl+T picks the Type tool; click the stage to type'),
    t('ui.loadingScreen.tip.measure', 'Hold Alt and hover a layer to measure to it'),
    t('ui.loadingScreen.tip.guide', 'Drag the ruler to pull out a guide'),
    t('ui.loadingScreen.tip.assistant', 'The Assistant proposes three concepts before it builds'),
  ];
}

export function LoadingScreen({ message = t('ui.loadingScreen.loading', 'Loading editor…'), fullScreen = false }: LoadingScreenProps): JSX.Element {
  const stage = useBootStageStore((s) => s.stage);
  const done = useBootStageStore((s) => s.done);
  const progress = useBootStageStore((s) => s.progress);
  const [tip] = useState(() => {
    const all = tips();
    return all[Math.floor(Math.random() * all.length)] ?? all[0]!;
  });
  // The screen may mount before the boot reports anything: the line sweeps
  // until a stage lands, then tracks the boot.
  const [known, setKnown] = useState(stage !== null || done.size > 0);
  useEffect(() => {
    if (stage !== null || done.size > 0) setKnown(true);
  }, [stage, done]);
  const fraction = bootFraction({ stage, done, progress });
  const line = stage
    ? bootStageVerb(stage)
    : done.size === BOOT_STAGES.length
      ? t('ui.loadingScreen.opening', 'Opening the workspace')
      : message;

  return (
    <div
      className={styles.root}
      style={fullScreen ? { position: 'fixed', zIndex: 9999 } : undefined}
      role="status"
      aria-label={line}
    >
      <div className={styles.mark}>
        <Logo variant="mark" size={30} className={styles.logo} />
        <span className={styles.word}>Premation</span>
      </div>
      <div className={cn(styles.line, !known && styles.lineSweep)} aria-hidden>
        <i style={known ? { transform: `scaleX(${fraction.toFixed(3)})` } : undefined} />
      </div>
      <div className={styles.stage}>
        {line}
        {progress && progress.total > 0 && (
          <span className={styles.count}>{progress.done} / {progress.total}</span>
        )}
      </div>
      {known && (
        <div className={styles.stages} aria-hidden>
          {BOOT_STAGES.map((s) => (
            <span key={s} className={cn(styles.stageName, done.has(s) && styles.stageDone, stage === s && styles.stageNow)}>
              {bootStageLabel(s)}
            </span>
          ))}
        </div>
      )}
      <span className={styles.corner}>v{APP_VERSION}</span>
      <span className={styles.corner2}>{tip}</span>
    </div>
  );
}

export default LoadingScreen;
