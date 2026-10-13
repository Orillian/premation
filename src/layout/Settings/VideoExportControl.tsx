/**
 * Settings ▸ Video export: is the ffmpeg export runs working, and the way to
 * fix or replace it without waiting for an export to fail
 * (src/stores/ffmpegStore.ts, the dialog in src/layout/Export).
 */

import { useEffect } from 'react';
import { Button } from '@components/Button';
import { useFfmpegStore } from '@stores/ffmpegStore';
import styles from './ObjectMatteControl.module.css';

const SOURCE_LABEL: Record<string, string> = {
  bundled: 'Built in',
  repaired: 'Repaired copy',
  chosen: 'Your FFmpeg',
  override: 'FFMPEG_PATH',
  system: 'System FFmpeg',
};

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
    return <div className={styles.root}><span className={styles.progressText}>Checking…</span></div>;
  }

  if (status.ok && status.active) {
    return (
      <div className={styles.root}>
        <div className={styles.readyRow}>
          <span className={styles.ready}>Working · {SOURCE_LABEL[status.active.source] ?? status.active.source}</span>
          <Button variant="secondary" size="sm" onClick={() => { void refresh(true); }}>Check again</Button>
        </div>
        {status.active.source === 'chosen' ? (
          <div className={styles.readyRow}>
            <div className={styles.source} title={status.active.path}>{status.active.path}</div>
            <Button variant="ghost" size="sm" onClick={() => { void clearChoice(); }}>Use built-in</Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.readyRow}>
        <span className={styles.error}>
          {status.repairing ? 'Repairing…' : status.active ? 'Some video formats unavailable' : 'Not working'}
        </span>
        <Button variant="primary" size="sm" onClick={() => openDialog()}>Fix…</Button>
      </div>
      <div className={styles.hint}>Images, image sequences and WAV audio export without it.</div>
    </div>
  );
}

export default VideoExportControl;
