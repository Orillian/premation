/**
 * Tasks — every background job in one dockable list (Window ▸ Panels ▸ Tasks,
 * or a click on the status bar's job tray).
 *
 * Premiere's Progress panel: one row per job with its progress, how long it
 * has run and about how long it has left, and a stop button while it runs;
 * finished jobs stay below as history (the newest `MAX_FINISHED_JOBS`) until
 * "Clear finished". After Effects has no such panel — its jobs report where
 * they started (Render Queue, the Content-Aware Fill footer, Roto Brush's
 * banner) — which is fine until two things run at once.
 *
 * Reads `uiStore.jobs` directly. Store writes are already coalesced to ~4 Hz
 * per job (`updateJob`); the only other render is a 1 Hz tick for the elapsed
 * and remaining times, and only while something is running.
 */

import { useEffect, useState } from 'react';
import { Button } from '@components/Button';
import { EmptyState } from '@components/EmptyState';
import { Icon, type IconName } from '@components/Icon';
import { Progress } from '@components/Progress';
import { estimateJobRemainingMs, useUIStore, type Job, type JobKind } from '@stores/uiStore';
import { t } from '@core/i18n';
import { formatElapsed, formatRemaining } from './taskTime';
import styles from './TasksPanel.module.css';

const KIND_ICON: Record<JobKind, IconName> = {
  export: 'export',
  render: 'video',
  download: 'download',
  transcribe: 'mic',
  import: 'upload',
  analysis: 'crosshair',
  other: 'clock',
};

/** Running first (oldest on top, the order they started), then finished, newest first. */
function ordered(jobs: ReadonlyArray<Job>): { running: Job[]; finished: Job[] } {
  const running = jobs.filter((j) => j.status === 'running');
  const finished = jobs
    .filter((j) => j.status !== 'running')
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  return { running, finished };
}

/** `Date.now()`, re-read once a second while `live` — the elapsed / ETA clock. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}

function rowIcon(job: Job): { name: IconName; tone?: 'done' | 'failed' | 'cancelled' } {
  if (job.status === 'done') return { name: 'success', tone: 'done' };
  if (job.status === 'failed') return { name: 'error', tone: 'failed' };
  if (job.status === 'cancelled') return { name: 'stop', tone: 'cancelled' };
  return { name: KIND_ICON[job.kind ?? 'other'] };
}

function timeLine(job: Job, now: number): string {
  if (job.status !== 'running') {
    const took = formatElapsed((job.finishedAt ?? now) - job.startedAt);
    return job.status === 'done'
      ? t('tasks.row.took', 'Took {time}', { time: took })
      : t('tasks.row.ranFor', 'Ran {time}', { time: took });
  }
  const elapsed = formatElapsed(now - job.startedAt);
  if (job.cancelRequested) return t('tasks.row.stopping', '{elapsed} · stopping…', { elapsed });
  const left = estimateJobRemainingMs(job, now);
  return left === null ? elapsed : t('tasks.row.elapsedLeft', '{elapsed} · {left}', { elapsed, left: formatRemaining(left) });
}

function TaskRow({ job, now }: { job: Job; now: number }): JSX.Element {
  const running = job.status === 'running';
  const icon = rowIcon(job);
  const indeterminate = job.progress === 'indeterminate';
  const pct = indeterminate ? null : Math.round((job.progress as number) * 100);
  const note = running
    ? job.statusLine
    : job.status === 'failed'
      ? job.error ?? job.message
      : job.message;
  const cancelLabel = t('tasks.row.cancel', 'Cancel {label}', { label: job.label });
  const clearLabel = t('tasks.row.clear', 'Remove from list');
  return (
    <li className={styles.row} data-status={job.status} aria-label={job.label}>
      <span className={styles.icon} data-tone={icon.tone} aria-hidden>
        <Icon name={icon.name} size="sm" />
      </span>
      <div className={styles.main}>
        <div className={styles.head}>
          <span className={styles.label} title={job.label}>{job.label}</span>
          {running && pct !== null ? <span className={styles.pct}>{pct}%</span> : null}
          {running && job.cancel ? (
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              icon={<Icon name="close" size="sm" />}
              title={cancelLabel}
              aria-label={cancelLabel}
              disabled={job.cancelRequested === true}
              onClick={() => useUIStore.getState().cancelJob(job.id)}
            />
          ) : null}
          {!running ? (
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              icon={<Icon name="close" size="sm" />}
              title={clearLabel}
              aria-label={clearLabel}
              onClick={() => useUIStore.getState().clearJob(job.id)}
            />
          ) : null}
        </div>
        {running ? (
          <Progress
            className={styles.bar}
            size="sm"
            value={indeterminate ? 0 : (job.progress as number)}
            indeterminate={indeterminate}
            aria-label={job.label}
          />
        ) : null}
        <div className={styles.meta}>
          {note ? (
            <span className={styles.note} data-tone={job.status === 'failed' ? 'failed' : undefined} title={note}>{note}</span>
          ) : null}
          <span className={styles.time}>{timeLine(job, now)}</span>
        </div>
      </div>
    </li>
  );
}

export function TasksPanel(): JSX.Element {
  const jobs = useUIStore((s) => s.jobs);
  const { running, finished } = ordered(jobs);
  const now = useNow(running.length > 0);

  return (
    <div className={styles.root}>
      <div className={styles.top}>
        <span className={styles.summary} role="status">
          {running.length > 0
            ? t('tasks.summary.running', '{n} running', { n: running.length })
            : t('tasks.summary.idle', 'Nothing running')}
        </span>
        <Button
          variant="ghost"
          size="xs"
          disabled={finished.length === 0}
          onClick={() => useUIStore.getState().clearFinishedJobs()}
        >
          {t('tasks.clearFinished', 'Clear finished')}
        </Button>
      </div>
      <div className={styles.body}>
        {jobs.length === 0 ? (
          <EmptyState
            icon="queue"
            compact
            message={t('tasks.empty', 'Exports, downloads, transcriptions and imports show their progress here while they run.')}
          />
        ) : (
          <ul className={styles.list} aria-label={t('tasks.listLabel', 'Background tasks')}>
            {running.map((job) => <TaskRow key={job.id} job={job} now={now} />)}
            {finished.map((job) => <TaskRow key={job.id} job={job} now={now} />)}
          </ul>
        )}
      </div>
    </div>
  );
}
