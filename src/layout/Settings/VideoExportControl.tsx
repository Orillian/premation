/**
 * Settings ▸ Video export: is the ffmpeg export runs working, and the way to
 * fix or replace it without waiting for an export to fail
 * (src/stores/ffmpegStore.ts, the dialog in src/layout/Export).
 */

import { useEffect } from 'react';
import { Button } from '@components/Button';
import { useFfmpegStore } from '@stores/ffmpegStore';
import { t } from '@core/i18n';
import styles from './ObjectMatteControl.module.css';

/** A function, not a constant: t() must run at render time. */
function sourceLabel(source: string): string | undefined {
  const labels: Record<string, string> = {
    bundled: t('settings.videoExport.sourceBundled', 'Built in'),
    repaired: t('settings.videoExport.sourceRepaired', 'Repaired copy'),
    chosen: t('settings.videoExport.sourceChosen', 'Your FFmpeg'),
    override: 'FFMPEG_PATH',
    system: t('settings.videoExport.sourceSystem', 'System FFmpeg'),
  };
  return labels[source];
}

export function VideoExportControl(): JSX.Element | null {
  const status = useFfmpegStore((s) => s.status);
  const openDialog = useFfmpegStore((s) => s.openDialog);
  const refresh = useFfmpegStore((s) => s.refresh);

  useEffect(() => {
    useFfmpegStore.getState().init();
  }, []);

  if (typeof window === 'undefined' || !window.motionEditor?.ffmpeg) return null;

  const clearChoice = async (): Promise<void> => {
    const next = await window.motionEditor?.ffmpeg?.clearChoice();
    if (next) useFfmpegStore.setState({ status: next });
  };

  if (!status || status.checkedAt === 0) {
    return <div className={styles.root}><span className={styles.progressText}>{t('settings.videoExport.checking', 'Checking…')}</span></div>;
  }

  if (status.ok && status.active) {
    return (
      <div className={styles.root}>
        <div className={styles.readyRow}>
          <span className={styles.ready}>{t('settings.videoExport.working', 'Working · {source}', { source: sourceLabel(status.active.source) ?? status.active.source })}</span>
          <Button variant="secondary" size="sm" onClick={() => { void refresh(true); }}>{t('settings.videoExport.checkAgain', 'Check again')}</Button>
        </div>
        {status.active.source === 'chosen' ? (
          <div className={styles.readyRow}>
            <div className={styles.source} title={status.active.path}>{status.active.path}</div>
            <Button variant="ghost" size="sm" onClick={() => { void clearChoice(); }}>{t('settings.videoExport.useBuiltIn', 'Use built-in')}</Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.readyRow}>
        <span className={styles.error}>
          {status.repairing
            ? t('settings.videoExport.repairing', 'Repairing…')
            : status.active
              ? t('settings.videoExport.partial', 'Some video formats unavailable')
              : t('settings.videoExport.notWorking', 'Not working')}
        </span>
        <Button variant="primary" size="sm" onClick={() => openDialog()}>{t('settings.videoExport.fix', 'Fix…')}</Button>
      </div>
      <div className={styles.hint}>{t('settings.videoExport.hint', 'Images, image sequences and WAV audio export without it.')}</div>
    </div>
  );
}

export default VideoExportControl;
