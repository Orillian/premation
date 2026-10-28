/**
 * The Tasks panel's clock words: how long a job has run, and roughly how long
 * it has left. The estimate itself is `estimateJobRemainingMs` (uiStore); this
 * only turns milliseconds into the line a person reads, in Premiere's register
 * ("about 2 min left"), never a false-precision countdown.
 */

import { t } from '@core/i18n';

/** `0:05`, `12:34`, `1:02:03`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "about 40 sec left", "about 2 min left", "about 1 h 15 min left". */
export function formatRemaining(ms: number): string {
  if (ms < 5000) return t('tasks.eta.almostDone', 'almost done');
  if (ms < 60_000) {
    // Fives: a seconds figure that ticks by one reads as more exact than it is.
    const sec = Math.min(55, Math.max(5, Math.round(ms / 5000) * 5));
    return t('tasks.eta.seconds', 'about {n} sec left', { n: sec });
  }
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return t('tasks.eta.minutes', 'about {n} min left', { n: Math.max(1, minutes) });
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0
    ? t('tasks.eta.hours', 'about {h} h left', { h })
    : t('tasks.eta.hoursMinutes', 'about {h} h {m} min left', { h, m });
}
