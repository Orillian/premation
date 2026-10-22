/**
 * TimelineFooter — After Effects' timeline footer (owner redesign 2026-10-14).
 *
 * Two columns, the columns above them: under the layer outline, the frame
 * render time and "Toggle Switches / Modes"; under the lanes, the zoom slider
 * between its two mountain glyphs. The zoom lived in the status bar while this
 * row had nothing else to hold (an empty 22px strip across half the panel);
 * with the render time and the toggle it is AE's footer again, and the zoom is
 * back where AE users reach for it.
 */

import { useEffect, useState } from 'react';
import { useUIStore } from '@stores/uiStore';
import { viewportHudStats } from '@stores/viewportDisplayStore';
import { TimelineZoom } from '@layout/StatusBar/TimelineZoom';
import { usePreviewCacheStats } from '@layout/Timeline/CacheActions';
import { describePreviewCache } from '@layout/Timeline/previewCacheStats';
import { t } from '@core/i18n';
import styles from './BottomTimeline.module.css';

/** How often the readout re-reads the render loop's rolling mean. */
const SAMPLE_MS = 500;

/**
 * The rolling mean of the last real renders, read twice a second — not per
 * played frame (performance discipline: no React render per frame). The state
 * only changes when the rounded figure does, so a steady comp renders nothing.
 */
function FrameRenderTime(): JSX.Element {
  const [ms, setMs] = useState(() => Math.round(viewportHudStats.sample().frameMs));
  useEffect(() => {
    const id = window.setInterval(() => {
      const next = Math.round(viewportHudStats.sample().frameMs);
      setMs((cur) => (cur === next ? cur : next));
    }, SAMPLE_MS);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span className={styles.footerReadout} title={t('timeline.footer.renderTimeTitle', 'Mean time to render a frame, over the last 30 renders')}>
      {t('timeline.footer.renderTime', 'Frame Render Time:')} <b className={styles.footerValue}>{ms > 0 ? `${ms}ms` : '—'}</b>
    </span>
  );
}

/**
 * The cache lanes under the navigator, as two figures: how much of the comp
 * (or work area) plays from memory, and how much the disk tier holds. Read
 * at 2Hz through `usePreviewCacheStats`, never per frame.
 */
function CacheReadout(): JSX.Element {
  const { stats } = usePreviewCacheStats();
  if (stats.total <= 0) return <span className={styles.footerReadout}>{t('timeline.footer.cacheEmpty', 'Cache —')}</span>;
  const ram = Math.round((stats.cached / stats.total) * 100);
  const disk = stats.diskMb === null ? null : Math.round((stats.onDisk / stats.total) * 100);
  return (
    <span className={styles.footerReadout} title={describePreviewCache(stats)}>
      {disk === null
        ? t('timeline.footer.cacheRam', 'Cache {ram}% RAM', { ram })
        : t('timeline.footer.cacheRamDisk', 'Cache {ram}% RAM · {disk}% disk', { ram, disk })}
    </span>
  );
}

export interface TimelineFooterProps {
  /** The track-header column's width, so the two halves sit under their columns. */
  headerWidth: number;
}

export function TimelineFooter({ headerWidth }: TimelineFooterProps): JSX.Element {
  const cycleColumns = useUIStore((s) => s.cycleTimelineColumns);
  return (
    <div className={styles.footer} aria-label={t('timeline.footer.aria', 'Timeline footer')}>
      <div className={styles.footerLeft} style={{ width: headerWidth }}>
        <FrameRenderTime />
        <CacheReadout />
        <button
          type="button"
          className={styles.footerToggle}
          title={t('timeline.footer.toggleColumnsTitle', 'Cycle the columns: Switches, Modes, both (F4)')}
          onClick={() => cycleColumns()}
        >
          {t('timeline.footer.toggleColumns', 'Toggle Switches / Modes')}
        </button>
      </div>
      <div className={styles.footerRight}>
        <TimelineZoom />
      </div>
    </div>
  );
}

export default TimelineFooter;
