/**
 * NavCacheStrip — the preview-coverage lanes, under the time navigator
 * (the 2026-10-19 sheet): green where a frame is in memory (the engine's VRAM
 * and RAM tiers), blue where it is in the disk cache, one 1.5px line each,
 * spanning the WHOLE composition on the navigator's own scale. It replaced
 * the lines that hung off the ruler and scrolled with it: one strip you read
 * at a glance, in the place that already stands for the whole comp.
 *
 * Self-subscribing and throttled, the way `CacheBars` was and for the same
 * reason: coverage changes on every cached frame, and nothing above this leaf
 * may re-render for that. Segments are laid out in PERCENT of the comp, so
 * the strip needs no width of its own and never re-lays out on a resize.
 */

import { memo, useEffect, useState } from 'react';
import { coalesceCacheBarRanges, type CacheTimeRange } from '@layout/Timeline/cacheBarLayout';
import { engineCacheSnapshot, subscribeEngineCache } from '@layout/Timeline/engineCacheCoverage';
import styles from './BottomTimeline.module.css';

/** How often the strip re-reads coverage while it is changing. */
const REFRESH_HZ = 10;

interface Lanes {
  ram: CacheTimeRange[];
  disk: CacheTimeRange[];
}

const EMPTY: Lanes = { ram: [], disk: [] };

function sameRanges(a: ReadonlyArray<CacheTimeRange>, b: ReadonlyArray<CacheTimeRange>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.start !== b[i]!.start || a[i]!.end !== b[i]!.end) return false;
  }
  return true;
}

export interface NavCacheStripProps {
  /** Composition frame rate — gaps are bridged in frames. */
  fps: number;
  /** Composition length in seconds: the strip's full width. */
  duration: number;
}

function NavCacheStripImpl({ fps, duration }: NavCacheStripProps): JSX.Element | null {
  const [lanes, setLanes] = useState<Lanes>(EMPTY);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sample = (): void => {
      const snap = engineCacheSnapshot();
      // A huge px/s so the bridge rule is the frame gap alone — the strip has
      // no pixel scale of its own.
      const next: Lanes = {
        ram: coalesceCacheBarRanges(snap.ram, fps, 1e9),
        disk: coalesceCacheBarRanges(snap.disk, fps, 1e9),
      };
      setLanes((cur) => (sameRanges(cur.ram, next.ram) && sameRanges(cur.disk, next.disk) ? cur : next));
    };
    const flush = (): void => {
      timer = null;
      sample();
    };
    const off = subscribeEngineCache(() => {
      if (timer !== null) return;
      timer = setTimeout(flush, 1000 / REFRESH_HZ);
    });
    sample();
    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, [fps]);

  if (!(duration > 0) || (lanes.ram.length === 0 && lanes.disk.length === 0)) return null;

  const pct = (sec: number): number => Math.max(0, Math.min(100, (sec / duration) * 100));

  return (
    <div className={styles.navCacheStrip} aria-hidden data-timeline-cache-strip="">
      <div className={styles.navCacheLane}>
        {lanes.ram.map((r, i) => (
          <span key={`ram_${i}`} className={styles.navCacheRam} style={{ left: `${pct(r.start)}%`, width: `${Math.max(0.2, pct(r.end) - pct(r.start))}%` }} />
        ))}
      </div>
      <div className={styles.navCacheLane}>
        {lanes.disk.map((r, i) => (
          <span key={`disk_${i}`} className={styles.navCacheDisk} style={{ left: `${pct(r.start)}%`, width: `${Math.max(0.2, pct(r.end) - pct(r.start))}%` }} />
        ))}
      </div>
    </div>
  );
}

export const NavCacheStrip = memo(NavCacheStripImpl);
