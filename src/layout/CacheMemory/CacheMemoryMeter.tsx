/**
 * The memory meter at the right end of the viewer's transport bar: a status
 * dot and "RAM 6.1 / 12 GB", always in view, so memory trouble shows where
 * the stutter is seen rather than in a panel nobody has open. Its popover has
 * the essentials (the three tiers, this composition's coverage, Cache Work
 * Area Now, Purge, Cache before playback) and opens the Cache & Memory panel.
 *
 * Reads `engineMemory` (2 s poll) and `usePreviewCacheStats` (2 Hz while the
 * popover is open), so it re-renders at most twice a second, never per frame.
 * `compact` (the bar has shed its zoom field) keeps only the dot.
 */

import { memo, useState } from 'react';
import { Popover } from '@components/Popover';
import { Switch } from '@components/Switch';
import { Button } from '@components/Button';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useLayoutStore } from '@stores/layoutStore';
import { formatBytes } from '@core/perf/memoryHealth';
import { t } from '@core/i18n';
import { usePreviewCacheStats } from '@layout/Timeline/CacheActions';
import { cacheWorkAreaNow, canCacheWorkArea, purgeRamPreview } from '@layout/Timeline/previewCacheCommands';
import { useEngineMemory } from './CacheMemoryPanel';
import { refreshEngineMemory } from './engineMemory';
import { healthCopy, healthTone } from './memoryCopy';
import styles from './CacheMemoryMeter.module.css';

function MeterPopover({ onClose }: { onClose: () => void }): JSX.Element {
  const mem = useEngineMemory();
  const { stats: cache, refresh } = usePreviewCacheStats();
  const cacheBeforePlayback = usePreferenceStore((s) => s.cacheBeforePlayback);
  const r = mem.readout;
  const copy = healthCopy(mem.health, r);
  const full = cache.total > 0 && cache.cached >= cache.total;

  const rows = [
    { id: 'ram', name: t('cacheMemory.tier.ram', 'RAM previews'), used: r?.ramBytes ?? 0, budget: r?.ramBudget ?? 0 },
    { id: 'vram', name: t('cacheMemory.tier.vram', 'Video memory'), used: r?.vramBytes ?? 0, budget: r?.vramBudget ?? 0 },
    { id: 'disk', name: t('cacheMemory.tier.disk', 'Disk cache'), used: r?.diskBytes ?? 0, budget: r?.diskBudget ?? 0 },
  ];

  return (
    <div className={styles.pop} role="dialog" aria-label={t('cacheMemory.title', 'Cache & Memory')}>
      <div className={styles.popHead} data-tone={healthTone(mem.health)}>
        <span className={styles.dot} aria-hidden />
        <span className={styles.popTitle}>{copy.title}</span>
      </div>
      {rows.map((row) => (
        <div key={row.id} className={styles.row}>
          <div className={styles.rowHead}>
            <span>{row.name}</span>
            <span className={styles.num}>{row.budget > 0 ? `${formatBytes(row.used)} / ${formatBytes(row.budget)}` : row.used > 0 ? formatBytes(row.used) : t('cacheMemory.off', 'Off')}</span>
          </div>
          <div className={styles.track} aria-hidden>
            <span className={styles.fill} data-tone={row.id} style={{ width: `${row.budget > 0 ? Math.min(100, (row.used / row.budget) * 100) : 0}%` }} />
          </div>
        </div>
      ))}
      <div className={styles.rowHead}>
        <span>{t('cacheMemory.comp', 'This composition')}</span>
        <span className={styles.num}>{cache.total > 0 ? t('cacheMemory.compFrames', '{cached} / {total} frames', { cached: cache.cached, total: cache.total }) : '—'}</span>
      </div>
      <label className={styles.switchRow}>
        <span>{t('cacheMemory.cacheFirst', 'Cache before playback')}</span>
        <Switch
          checked={cacheBeforePlayback}
          onChange={(e) => usePreferenceStore.getState().set('cacheBeforePlayback', e.currentTarget.checked)}
          aria-label={t('cacheMemory.cacheFirst', 'Cache before playback')}
        />
      </label>
      <div className={styles.actions}>
        <Button
          variant="primary"
          size="sm"
          disabled={!canCacheWorkArea() || cache.total === 0 || full}
          onClick={() => { cacheWorkAreaNow(); refresh(); }}
        >
          {full ? t('cacheMemory.cached', 'All cached') : t('timeline.cache.cacheWorkAreaNow', 'Cache Work Area Now')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={cache.ramMb <= 0}
          onClick={() => { purgeRamPreview(); refresh(); refreshEngineMemory(); }}
        >
          {t('cacheMemory.purgeShort', 'Purge RAM')}
        </Button>
      </div>
      <button
        type="button"
        className={styles.link}
        onClick={() => {
          onClose();
          useLayoutStore.getState().openPanel('cacheMemory');
        }}
      >
        {t('cacheMemory.openPanel', 'Open Cache & Memory panel')}
      </button>
    </div>
  );
}

function CacheMemoryMeterImpl({ compact = false }: { compact?: boolean }): JSX.Element {
  const mem = useEngineMemory();
  const [open, setOpen] = useState(false);
  const r = mem.readout;
  const copy = healthCopy(mem.health, r);
  const text = r
    ? r.ramBudget
      ? t('cacheMemory.meter', 'RAM {used} / {budget}', { used: formatBytes(r.ramBytes), budget: formatBytes(r.ramBudget) })
      : t('cacheMemory.meterNoBudget', 'RAM {used}', { used: formatBytes(r.ramBytes) })
    : t('cacheMemory.meterWaiting', 'RAM —');

  return (
    <Popover
      placement="top-end"
      bare
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          type="button"
          className={styles.meter}
          data-tone={healthTone(mem.health)}
          data-compact={compact ? '' : undefined}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t('cacheMemory.meterAria', 'Cache and memory: {status}. {text}', { status: copy.title, text })}
          title={`${copy.title} — ${copy.body}`}
        >
          <span className={styles.dot} aria-hidden />
          {!compact && <span className={styles.num}>{text}</span>}
        </button>
      }
    >
      <MeterPopover onClose={() => setOpen(false)} />
    </Popover>
  );
}

export const CacheMemoryMeter = memo(CacheMemoryMeterImpl);
