/**
 * What the Cache & Memory panel's banner and the transport bar's meter say
 * about the engine's memory — one wording for both.
 */

import { formatBytes, type MemoryHealth, type MemoryReadout } from '@core/perf/memoryHealth';
import { t } from '@core/i18n';

export type HealthTone = 'ok' | 'warn' | 'bad';

export function healthTone(h: MemoryHealth): HealthTone {
  return h.kind === 'growing' ? 'bad' : h.kind === 'pressure' ? 'warn' : 'ok';
}

export function healthCopy(h: MemoryHealth, r: MemoryReadout | null): { title: string; body: string } {
  if (!r) {
    return {
      title: t('cacheMemory.health.waiting', 'Reading the engine…'),
      body: t('cacheMemory.health.waitingBody', 'Figures appear once the engine answers.'),
    };
  }
  if (h.kind === 'growing') {
    return {
      title: t('cacheMemory.health.growing', 'Engine memory keeps growing'),
      body: t('cacheMemory.health.growingBody', '{outside} is held outside the caches and has grown about {rate} a minute. Restart the engine from Diagnostics to free it — the project stays open.', {
        outside: formatBytes(r.outsideCachesBytes ?? 0),
        rate: formatBytes(h.growthPerMin ?? 0),
      }),
    };
  }
  if (h.kind === 'pressure' && h.pressure === 'machine') {
    return {
      title: t('cacheMemory.health.machine', 'This machine is low on memory'),
      body: t('cacheMemory.health.machineBody', 'Only {free} is free. Previews give memory back first; closing other apps or lowering RAM for previews helps.', { free: formatBytes(r.availableBytes ?? 0) }),
    };
  }
  if (h.kind === 'pressure') {
    return {
      title: t('cacheMemory.health.ramFull', 'RAM previews are full'),
      body: t('cacheMemory.health.ramFullBody', 'The oldest frames make way for new ones (to disk first when the disk cache is on), so the frames you play stay cached.'),
    };
  }
  return {
    title: t('cacheMemory.health.ok', 'Healthy'),
    body: r.ramBudget
      ? t('cacheMemory.health.okBody', 'Previews fit in memory: {used} of {budget} for RAM previews.', { used: formatBytes(r.ramBytes), budget: formatBytes(r.ramBudget) })
      : t('cacheMemory.health.okBodyNoBudget', 'Previews fit in memory.'),
  };
}
