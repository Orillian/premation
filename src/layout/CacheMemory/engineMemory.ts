/**
 * The engine's memory as the Cache & Memory panel and the transport bar's
 * meter show it — `getRenderStats`, polled while anything is subscribed.
 *
 * Like `engineCacheCoverage`, a subscriber keeps the poll running and with
 * none nothing asks. The engine only pushes `renderStatsUpdated` while it
 * plays, so the meter (always on screen) asks every POLL_MS instead; the
 * answer is a few numbers.
 *
 * While the Diagnostics view's "Heaviest layers" is on screen
 * (`wantLayerCosts`), each poll also asks the engine to time the next frame it
 * draws per layer (`profileLayers`); otherwise no frame is sampled.
 *
 * Kept here, not in the engine: the 30-minute history the leak signal and the
 * chart read (`core/perf/memoryHealth.ts`), and a short log of what happened
 * to memory this session (engine restarts, budget reached, growth warnings).
 */

import type { RenderStats } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { lastProcessEngineNotice, subscribeProcessEngine } from '@core/engine/process/processEngine';
import {
  memoryHealth,
  readMemory,
  type MemoryHealth,
  type MemoryReadout,
  type MemorySample,
} from '@core/perf/memoryHealth';

/** How often the engine is asked. */
const POLL_MS = 2000;
/** How often a point goes into the history, and how much of it is kept. */
const SAMPLE_EVERY_MS = 10_000;
const HISTORY_MS = 30 * 60_000;
const MAX_EVENTS = 20;

export interface MemoryEvent {
  at: number;
  kind: 'restarted' | 'pressure' | 'growing' | 'recovered';
  /** For `restarted`: why. */
  cause?: string;
}

export interface EngineMemorySnapshot {
  /** Null until the engine first answers. */
  readout: MemoryReadout | null;
  /** The engine's last answer as it came (frame timings for the Diagnostics tab). */
  stats: RenderStats | null;
  health: MemoryHealth;
  history: readonly MemorySample[];
  events: readonly MemoryEvent[];
}

const EMPTY: EngineMemorySnapshot = { readout: null, stats: null, health: { kind: 'healthy' }, history: [], events: [] };
let snap: EngineMemorySnapshot = EMPTY;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight = false;
let lastNotice: unknown = lastProcessEngineNotice();
let offNotice: (() => void) | null = null;
/** Mounted "Heaviest layers" views: while any is, polls ask for a per-layer sample. */
let layerCostViewers = 0;

const MiB = 1024 * 1024;
const roundMb = (n: number | null): number | null => (n === null ? null : Math.round(n / MiB));

function sameReadout(a: MemoryReadout | null, b: MemoryReadout): boolean {
  if (!a) return false;
  return roundMb(a.vramBytes) === roundMb(b.vramBytes) && roundMb(a.ramBytes) === roundMb(b.ramBytes)
    && roundMb(a.diskBytes) === roundMb(b.diskBytes) && roundMb(a.engineBytes) === roundMb(b.engineBytes)
    && roundMb(a.availableBytes) === roundMb(b.availableBytes) && a.ramBudget === b.ramBudget
    && a.vramBudget === b.vramBudget && a.diskBudget === b.diskBudget && a.idleRenderAhead === b.idleRenderAhead
    && a.diskReadMsPerMp === b.diskReadMsPerMp && roundMb(a.gpuUsed) === roundMb(b.gpuUsed)
    && roundMb(a.gpuBudget) === roundMb(b.gpuBudget) && roundMb(a.gpuTrimmed) === roundMb(b.gpuTrimmed);
}

function emit(): void {
  for (const listener of listeners) listener();
}

function logEvent(e: MemoryEvent): void {
  snap = { ...snap, events: [e, ...snap.events].slice(0, MAX_EVENTS) };
}

function sameTimings(a: RenderStats | null, b: RenderStats): boolean {
  return !!a && Math.round(a.cpuFrameMs) === Math.round(b.cpuFrameMs) && Math.round(a.gpuFrameMs) === Math.round(b.gpuFrameMs)
    && Math.round(a.decodeMs) === Math.round(b.decodeMs) && a.droppedFrames === b.droppedFrames
    // A new per-layer sample (its total differs to the microsecond), or one appearing.
    && a.layerCostsFrameMs === b.layerCostsFrameMs && a.layerCosts.length === b.layerCosts.length;
}

function apply(stats: RenderStats, now: number): void {
  const readout = readMemory(stats);
  let history = snap.history;
  const lastAt = history.length ? history[history.length - 1]!.at : -Infinity;
  const appended = readout.engineBytes !== null && now - lastAt >= SAMPLE_EVERY_MS;
  if (appended) {
    history = [...history.filter((p) => now - p.at <= HISTORY_MS), { at: now, engineBytes: readout.engineBytes!, ramTierBytes: readout.ramBytes }];
  }
  const health = memoryHealth(readout, history, now);
  const changedKind = health.kind !== snap.health.kind || health.pressure !== snap.health.pressure;
  if (!appended && !changedKind && sameReadout(snap.readout, readout) && sameTimings(snap.stats, stats)) return;
  if (changedKind) {
    logEvent({ at: now, kind: health.kind === 'healthy' ? 'recovered' : health.kind });
  }
  snap = { ...snap, readout, stats, health, history };
  emit();
}

async function sample(): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    const res = await engine().query({ type: 'getRenderStats', profileLayers: layerCostViewers > 0 });
    if (res.ok) apply(res.value, Date.now());
  } catch {
    // The engine is restarting: the last figures stay until it answers.
  } finally {
    inflight = false;
  }
}

function loop(): void {
  void sample().finally(() => {
    if (listeners.size === 0) {
      timer = null;
      return;
    }
    timer = setTimeout(loop, POLL_MS);
  });
}

function watchRestarts(): void {
  if (offNotice) return;
  offNotice = subscribeProcessEngine(() => {
    const notice = lastProcessEngineNotice();
    if (notice === lastNotice || !notice) return;
    lastNotice = notice;
    if (notice.kind !== 'restarted') return;
    // A new process: its memory starts again, so the old history would read as a fall.
    snap = { ...snap, history: [] };
    logEvent({ at: Date.now(), kind: 'restarted', cause: notice.cause });
    emit();
  });
}

export function engineMemorySnapshot(): EngineMemorySnapshot {
  return snap;
}

export function subscribeEngineMemory(listener: () => void): () => void {
  listeners.add(listener);
  watchRestarts();
  if (timer === null) loop();
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Keep per-layer GPU samples coming while the caller is on screen (the
 * Diagnostics view's "Heaviest layers"). Returns the release.
 */
export function wantLayerCosts(): () => void {
  layerCostViewers++;
  void sample();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    layerCostViewers = Math.max(0, layerCostViewers - 1);
  };
}

/** Ask now (after a purge or a budget change), instead of at the next poll. */
export function refreshEngineMemory(): void {
  void sample();
}

/** Tests: forget everything. */
export function resetEngineMemoryForTests(): void {
  snap = EMPTY;
  layerCostViewers = 0;
  lastNotice = lastProcessEngineNotice();
}
