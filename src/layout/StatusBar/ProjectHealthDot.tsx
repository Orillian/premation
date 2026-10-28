/**
 * The status bar's Project Health dot: green while nothing needs doing, amber
 * for a suggestion (4K without proxies, memory at budget…), red for a broken
 * layer or memory that keeps growing. Clicking it opens Cache & Memory ▸
 * Health, which says what and offers the fix.
 *
 * Reads `useProjectHealth` without the cache coverage (that poll belongs to the
 * panel); its own wakes are the 2 s engine memory poll and mirror structure
 * changes, never a played frame.
 */

import { memo } from 'react';
import { t } from '@core/i18n';
import { openCacheMemoryPanel } from '@layout/CacheMemory/cacheMemoryView';
import { useProjectHealth } from '@layout/CacheMemory/useProjectHealth';
import styles from './ProjectHealthDot.module.css';

function ProjectHealthDotImpl(): JSX.Element {
  const { health } = useProjectHealth(null);
  const n = health.findings.length;
  const label = health.tone === 'ok'
    ? t('statusBar.health.ok', 'Project health: good')
    : n === 1
      ? t('statusBar.health.one', 'Project health: 1 suggestion')
      : t('statusBar.health.other', 'Project health: {n} suggestions', { n });
  return (
    <button
      type="button"
      className={styles.health}
      data-tone={health.tone}
      aria-label={label}
      title={`${label} — ${t('statusBar.health.open', 'open Cache & Memory ▸ Health')}`}
      onClick={() => openCacheMemoryPanel('health')}
    >
      <span className={styles.dot} aria-hidden />
    </button>
  );
}

export const ProjectHealthDot = memo(ProjectHealthDotImpl);
