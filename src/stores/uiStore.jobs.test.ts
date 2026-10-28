/**
 * Background jobs in `uiStore`: the time-remaining estimate, the ~4 Hz
 * coalescing of progress writes, cancel through the starter's handle, and the
 * finished-job history the Tasks panel lists.
 */

import {
  ETA_WARMUP_MS,
  JOB_UPDATE_INTERVAL_MS,
  MAX_FINISHED_JOBS,
  estimateJobRemainingMs,
  isJobCancelRequested,
  useUIStore,
  type Job,
} from './uiStore';

const T0 = new Date('2026-10-28T12:00:00Z').getTime();

function job(id: string): Job | undefined {
  return useUIStore.getState().jobs.find((j) => j.id === id);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  useUIStore.setState({ jobs: [], notifications: [] });
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

describe('estimateJobRemainingMs', () => {
  const base: Job = { id: 'j', label: 'Export', status: 'running', progress: 0.5, startedAt: T0 };

  it('says nothing for an indeterminate, warming-up or finished job', () => {
    expect(estimateJobRemainingMs({ ...base, progress: 'indeterminate' }, T0 + 10_000)).toBeNull();
    expect(estimateJobRemainingMs({ ...base, progressAt: T0 + 1000 }, T0 + 1000)).toBeNull();
    expect(estimateJobRemainingMs({ ...base, status: 'done', etaFrom: { at: T0, progress: 0 }, progressAt: T0 + 1 }, T0 + 1)).toBeNull();
  });

  it('extrapolates the rate since the warm-up baseline', () => {
    // 10% → 50% in 20 s: 2% a second, 50% to go → 25 s.
    const j: Job = { ...base, etaFrom: { at: T0 + 2000, progress: 0.1 }, progressAt: T0 + 22_000 };
    expect(estimateJobRemainingMs(j, T0 + 22_000)).toBe(25_000);
    // Counts down between samples, and never below zero.
    expect(estimateJobRemainingMs(j, T0 + 32_000)).toBe(15_000);
    expect(estimateJobRemainingMs(j, T0 + 90_000)).toBe(0);
  });

  it('needs movement since the baseline', () => {
    expect(estimateJobRemainingMs({ ...base, etaFrom: { at: T0 + 2000, progress: 0.5 }, progressAt: T0 + 3000 }, T0 + 3000)).toBeNull();
  });

  it('is measured from live updates, ignoring the warm-up', () => {
    const ui = useUIStore.getState();
    ui.startJob({ id: 'r', label: 'Render', progress: 0 });
    // A slow first second (file open, first frame) must not set the rate.
    jest.setSystemTime(T0 + 1000);
    ui.updateJob('r', { progress: 0.01 });
    expect(job('r')?.etaFrom).toBeUndefined();
    jest.setSystemTime(T0 + ETA_WARMUP_MS + 500);
    ui.updateJob('r', { progress: 0.1 });
    expect(job('r')?.etaFrom).toEqual({ at: T0 + 2000, progress: 0.1 });
    jest.setSystemTime(T0 + 12_000);
    ui.updateJob('r', { progress: 0.3 });
    // 20% in 10 s → 70% left = 35 s.
    expect(estimateJobRemainingMs(job('r')!, T0 + 12_000)).toBe(35_000);
  });
});

describe('updateJob coalescing', () => {
  it('applies at most one patch per interval, keeping the newest values', () => {
    const ui = useUIStore.getState();
    ui.startJob({ id: 'd', label: 'Download', progress: 0 });
    const writes: number[] = [];
    const off = useUIStore.subscribe((s) => s.jobs, (jobs) => {
      const p = jobs.find((j) => j.id === 'd')?.progress;
      if (typeof p === 'number') writes.push(p);
    });
    ui.updateJob('d', { progress: 0.1 }); // first: applied at once
    for (let i = 2; i <= 9; i++) {
      jest.setSystemTime(T0 + i * 10);
      ui.updateJob('d', { progress: i / 10 });
    }
    expect(writes).toEqual([0.1]);
    jest.advanceTimersByTime(JOB_UPDATE_INTERVAL_MS);
    expect(writes).toEqual([0.1, 0.9]);
    off();
  });

  it('flushes a queued label before the job finishes', () => {
    const ui = useUIStore.getState();
    ui.startJob({ id: 'd', label: 'Download' });
    ui.updateJob('d', { progress: 0.5 });
    ui.updateJob('d', { label: 'Download 90%', progress: 0.9 });
    ui.finishJob('d', { status: 'done' });
    expect(job('d')).toMatchObject({ status: 'done', label: 'Download 90%', progress: 1 });
  });
});

describe('cancel', () => {
  it('calls the handle registered at start, once, and marks the request', () => {
    const cancel = jest.fn();
    const ui = useUIStore.getState();
    ui.startJob({ id: 'e', label: 'Export', progress: 0, cancel });
    ui.cancelJob('e');
    ui.cancelJob('e');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(isJobCancelRequested('e')).toBe(true);
    // Still running until the starter reports the stop.
    expect(job('e')?.status).toBe('running');
    ui.finishJob('e', { status: 'cancelled' });
    expect(job('e')).toMatchObject({ status: 'cancelled' });
    expect(job('e')?.cancel).toBeUndefined();
    expect(isJobCancelRequested('e')).toBe(false);
  });

  it('takes a handle registered later through updateJob, without waiting for the throttle', () => {
    const cancel = jest.fn();
    const ui = useUIStore.getState();
    ui.startJob({ id: 'm', label: 'Import' });
    ui.updateJob('m', { progress: 0.2 });
    ui.updateJob('m', { cancel });
    expect(job('m')?.cancel).toBe(cancel);
    ui.cancelJob('m');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for a job without a handle', () => {
    const ui = useUIStore.getState();
    ui.startJob({ id: 'x', label: 'Thing' });
    ui.cancelJob('x');
    expect(isJobCancelRequested('x')).toBe(false);
  });
});

describe('finished history', () => {
  it('keeps finished jobs (no linger timeout), with the error text of a failure', () => {
    const ui = useUIStore.getState();
    ui.startJob({ id: 'f', label: 'Export' });
    ui.finishJob('f', { status: 'failed', message: 'Export failed', detail: 'Disk full' });
    jest.advanceTimersByTime(60_000);
    expect(job('f')).toMatchObject({ status: 'failed', error: 'Disk full', finishedAt: T0 });
  });

  it('keeps the newest MAX_FINISHED_JOBS and every running job', () => {
    const ui = useUIStore.getState();
    ui.startJob({ id: 'live', label: 'Still going' });
    for (let i = 0; i < MAX_FINISHED_JOBS + 5; i++) {
      jest.setSystemTime(T0 + i * 1000);
      ui.startJob({ id: `j${i}`, label: `Job ${i}` });
      ui.finishJob(`j${i}`, { status: 'done' });
    }
    const jobs = useUIStore.getState().jobs;
    expect(jobs.filter((j) => j.status !== 'running')).toHaveLength(MAX_FINISHED_JOBS);
    expect(job('j0')).toBeUndefined();
    expect(job(`j${MAX_FINISHED_JOBS + 4}`)).toBeDefined();
    expect(job('live')?.status).toBe('running');
  });

  it('keeps the previous run when an id is restarted', () => {
    const ui = useUIStore.getState();
    ui.startJob({ id: 'export', label: 'First' });
    ui.finishJob('export', { status: 'done' });
    jest.setSystemTime(T0 + 5000);
    ui.startJob({ id: 'export', label: 'Second' });
    const jobs = useUIStore.getState().jobs;
    expect(jobs.map((j) => [j.id, j.status])).toEqual([[`export#${T0}`, 'done'], ['export', 'running']]);
  });

  it('clears finished jobs, never running ones', () => {
    const ui = useUIStore.getState();
    ui.startJob({ id: 'a', label: 'A' });
    ui.startJob({ id: 'b', label: 'B' });
    ui.finishJob('b', { status: 'done' });
    ui.clearFinishedJobs();
    expect(useUIStore.getState().jobs.map((j) => j.id)).toEqual(['a']);
  });
});
