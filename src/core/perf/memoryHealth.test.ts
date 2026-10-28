import type { RenderStats } from '@motion/engine-api';
import { formatBytes, gpuHeldElsewhere, gpuShare, memoryHealth, readMemory, type MemorySample } from './memoryHealth';

const GiB = 1024 ** 3;

const base: RenderStats = {
  gpuFrameMs: 0, cpuFrameMs: 0, fps: 0, droppedFrames: 0, vramBytes: 0,
  ramCacheBytes: 0, diskCacheBytes: 0, cacheHitRate: 0, decodeMs: 0, layerCosts: [],
};

const history = (minutes: number, outside: (m: number) => number, ramTier = 2 * GiB): MemorySample[] =>
  Array.from({ length: minutes * 6 + 1 }, (_, i) => ({ at: i * 10_000, engineBytes: ramTier + outside(i / 6), ramTierBytes: ramTier }));

describe('readMemory', () => {
  it('splits the green bar into its VRAM and RAM tiers', () => {
    const m = readMemory({ ...base, ramCacheBytes: 5 * GiB, vramCacheBytes: 1 * GiB, engineMemoryBytes: 7 * GiB });
    expect(m.vramBytes).toBe(1 * GiB);
    expect(m.ramBytes).toBe(4 * GiB);
    expect(m.outsideCachesBytes).toBe(3 * GiB);
  });

  it('says nothing outside the caches without the engine figure', () => {
    expect(readMemory(base).outsideCachesBytes).toBeNull();
  });
});

describe('graphics memory', () => {
  const now = 20 * 60_000;

  it('reads the OS budget, the share used and what other apps hold', () => {
    const m = readMemory({ ...base, gpuMemoryBudget: 6 * GiB, gpuMemoryUsed: 3 * GiB, gpuMemoryTotal: 8 * GiB, gpuMemoryTrimmed: 512 * 1024 ** 2 });
    expect(gpuShare(m)).toBe(0.5);
    expect(gpuHeldElsewhere(m)).toBe(2 * GiB);
    expect(m.gpuTrimmed).toBe(512 * 1024 ** 2);
    expect(memoryHealth(m, [], now).kind).toBe('healthy');
  });

  it('is pressure near the line the OS draws for the engine', () => {
    const m = readMemory({ ...base, gpuMemoryBudget: 2 * GiB, gpuMemoryUsed: 1.9 * GiB, gpuMemoryTotal: 8 * GiB });
    expect(memoryHealth(m, [], now)).toEqual({ kind: 'pressure', pressure: 'gpu' });
  });

  it('says nothing where the OS does not report the card', () => {
    const m = readMemory(base);
    expect(gpuShare(m)).toBeNull();
    expect(gpuHeldElsewhere(m)).toBeNull();
    expect(m.gpuTrimmed).toBe(0);
  });
});

describe('memoryHealth', () => {
  const now = 20 * 60_000;

  it('is healthy with room in the budget and a flat history', () => {
    const m = readMemory({ ...base, ramCacheBytes: 2 * GiB, ramCacheBudget: 12 * GiB, engineMemoryBytes: 3 * GiB });
    expect(memoryHealth(m, history(20, () => GiB), now).kind).toBe('healthy');
  });

  it('is pressure at the RAM budget', () => {
    const m = readMemory({ ...base, ramCacheBytes: 11.7 * GiB, ramCacheBudget: 12 * GiB });
    expect(memoryHealth(m, [], now)).toEqual({ kind: 'pressure', pressure: 'ramBudget' });
  });

  it('is pressure when the machine is short of memory', () => {
    const m = readMemory({ ...base, physicalMemoryBytes: 16 * GiB, availableMemoryBytes: 0.5 * GiB });
    expect(memoryHealth(m, [], now)).toEqual({ kind: 'pressure', pressure: 'machine' });
  });

  it('is growing when memory outside the caches climbs steadily', () => {
    const m = readMemory({ ...base, engineMemoryBytes: 6 * GiB });
    const h = memoryHealth(m, history(20, (min) => GiB + min * 100 * 1024 ** 2), now);
    expect(h.kind).toBe('growing');
    expect(h.growthPerMin).toBeGreaterThan(90 * 1024 ** 2);
  });

  it('does not call a cache filling up a leak (the RAM tier grows, the rest is flat)', () => {
    const h = history(20, () => GiB).map((p, i) => ({ ...p, ramTierBytes: p.ramTierBytes + i * 50 * 1024 ** 2, engineBytes: p.engineBytes + i * 50 * 1024 ** 2 }));
    expect(memoryHealth(readMemory(base), h, now).kind).toBe('healthy');
  });

  it('waits for ten minutes of history before judging growth', () => {
    const h = history(5, (min) => GiB + min * 400 * 1024 ** 2);
    expect(memoryHealth(readMemory(base), h, 5 * 60_000).kind).toBe('healthy');
  });

  it('does not call a sawtooth that only drifts a leak', () => {
    const h = history(20, (min) => GiB + min * 60 * 1024 ** 2 + ((Math.round(min * 6) % 2) ? 600 : -600) * 1024 ** 2);
    expect(memoryHealth(readMemory(base), h, now).kind).toBe('healthy');
  });
});

describe('formatBytes', () => {
  it('prints MB under a gigabyte, GB with a decimal under ten, TB past 1024 GB', () => {
    expect(formatBytes(0)).toBe('0 MB');
    expect(formatBytes(820 * 1024 ** 2)).toBe('820 MB');
    expect(formatBytes(6.14 * GiB)).toBe('6.1 GB');
    expect(formatBytes(182 * GiB)).toBe('182 GB');
    expect(formatBytes(1.2 * 1024 * GiB)).toBe('1.2 TB');
  });
});
