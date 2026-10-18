/**
 * CacheBars — the preview-coverage lines under the timeline ruler, After
 * Effects' way: green where a frame is in memory (the engine's VRAM and RAM
 * tiers), blue where it is in the disk cache. Two rows, the blue one right
 * above the green (owner 2026-10-18): a frame on disk and in memory shows
 * both, one only on disk shows blue alone — what each tier holds reads at a
 * glance, as in AE. Both are the ENGINE's answer (`getCacheCoverage`): the
 * green is its VRAM + RAM tiers, the blue its disk tier's written files.
 *
 * ## Why this is its own component
 *
 * Coverage changes on EVERY cached frame: ~60 times a second through a first
 * playback pass, and again through every idle pre-render pass while the editor
 * sits paused. That state used to live as `useState` in the editor shell and
 * ride into `<Timeline>` inside the `timelineModel` object, which meant one
 * rendered frame re-rendered the entire application tree AND replaced the model
 * object that the timeline's whole memoization story is built on — the exact
 * thing the comment above `timelineModel` says it exists to prevent.
 *
 * So the lanes subscribe themselves, directly to the cache, and nothing above
 * this component re-renders when coverage changes.
 *
 * ## Why it refreshes on a timer rather than per change
 *
 * These are two 2–4px strips. Nobody can read them at 60Hz, and at typical zoom
 * a single frame of new coverage is a fraction of a pixel. Sampling at
 * {@link REFRESH_HZ} keeps the bar's growth visibly smooth while costing ~1/6th
 * of the React work, and it collapses the burst of notifications an idle slice
 * emits into one update.
 */

import { useEffect, useRef, useState, memo } from 'react';
import { coalesceCacheBarRanges, layoutCacheBarSegments, type CacheBarSegment } from './cacheBarLayout';
import { engineCacheSnapshot, subscribeEngineCache } from './engineCacheCoverage';
import styles from './Timeline.module.css';

/** How often the lanes re-read coverage while it is changing. */
const REFRESH_HZ = 10;

/** AE's disk-cache blue (tokens/domain.css); the theme's primary where a theme leaves it unset. */
const DISK_CACHE_COLOR = 'var(--color-timeline-disk-cache, var(--color-primary))';
/** The lines: the green hangs off the ruler's bottom edge, the blue sits right above it. */
const LINE_HEIGHT = 2;
const RAM_LINE_TOP = -2.5;
const DISK_LINE_TOP = RAM_LINE_TOP - LINE_HEIGHT - 1;

interface CacheBarsProps {
  /** Composition frame rate — cache keys are frames, the bar is seconds. */
  fps: number;
  /** Timeline zoom, px per second. */
  pixelsPerSecond: number;
  /** The ruler's left gutter, so lanes line up with ticks and the playhead. */
  leftOffset: number;
  /** Ruler height; the lanes hang off its bottom edge. */
  rulerHeight: number;
}

interface Lanes {
  ram: CacheBarSegment[];
  disk: CacheBarSegment[];
}

const NO_LANES: Lanes = { ram: [], disk: [] };

function CacheBarsImpl({ fps, pixelsPerSecond, leftOffset, rulerHeight }: CacheBarsProps): JSX.Element | null {
  const [lanes, setLanes] = useState<Lanes>(NO_LANES);

  // Read the layout inputs through a ref so a zoom change does not tear down
  // and rebuild the subscription — the sampler always sees current values.
  const layout = useRef({ fps, pixelsPerSecond, leftOffset });
  layout.current = { fps, pixelsPerSecond, leftOffset };

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const sample = (): void => {
      const { fps: f, pixelsPerSecond: pps, leftOffset: off } = layout.current;
      const safeFps = f > 0 ? f : 30;
      const coverage = engineCacheSnapshot();
      const ram = layoutCacheBarSegments(coalesceCacheBarRanges(coverage.ram, safeFps, pps), pps, off);
      const disk = layoutCacheBarSegments(coalesceCacheBarRanges(coverage.disk, safeFps, pps), pps, off);
      // Bail on an unchanged layout: a cache tick that adds a frame too small
      // to move a pixel boundary must not re-render the lanes.
      setLanes((prev) => (sameSegments(prev.ram, ram) && sameSegments(prev.disk, disk) ? prev : { ram, disk }));
    };

    const flush = (): void => {
      timer = null;
      sample();
    };

    const off = subscribeEngineCache(() => {
      // Trailing throttle: the first change of a burst schedules one flush and
      // every change until it fires rides along.
      if (timer !== null) return;
      timer = setTimeout(flush, 1000 / REFRESH_HZ);
    });

    // Zoom/fps changed, or we just mounted — re-layout the coverage we have
    // without waiting for the cache to tick again.
    sample();

    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, [fps, pixelsPerSecond, leftOffset]);

  if (lanes.ram.length === 0 && lanes.disk.length === 0) return null;

  return (
    <>
      {/* Disk cache — blue, its own line right above the green. */}
      {lanes.disk.map((seg, i) => (
        <div
          key={`disk_${i}`}
          className={styles.cacheBar}
          data-cache-tier="disk"
          style={{ left: seg.left, width: seg.width, top: rulerHeight + DISK_LINE_TOP, background: DISK_CACHE_COLOR }}
          aria-hidden
        />
      ))}
      {/* RAM preview — thin green indicator line directly under the ruler */}
      {lanes.ram.map((seg, i) => (
        <div
          key={`cache_${i}`}
          className={styles.cacheBar}
          data-cache-tier="ram"
          style={{ left: seg.left, width: seg.width, top: rulerHeight + RAM_LINE_TOP }}
          aria-hidden
        />
      ))}
    </>
  );
}

function sameSegments(a: ReadonlyArray<CacheBarSegment>, b: ReadonlyArray<CacheBarSegment>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.left !== b[i]!.left || a[i]!.width !== b[i]!.width) return false;
  }
  return true;
}

export const CacheBars = memo(CacheBarsImpl);
export default CacheBars;
