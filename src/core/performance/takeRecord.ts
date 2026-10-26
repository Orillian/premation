/**
 * A performance take as the document keeps it
 * (docs/PERFORMANCE_ANIMATION_PLAN.md §4.1, D5): the engine's
 * `PerformanceTake` — the raw samples, what recorded them, the fit they were
 * written with, and the span of keys they produced — stored on the layer by
 * `setPerformanceTake`, read back by `getPerformanceTakes`.
 *
 * Takes are source material, like footage: keys stay the only thing rendered.
 * Keeping the samples in the project is what lets the Detail control re-fit a
 * take after save / reopen and after undo, without performing again.
 *
 * Pure helpers (UI-side document helpers, never engine state): packing the
 * samples into the compact wire shape, unpacking them, the key span, and
 * which existing keys a re-fit keeps.
 */

import { secondsToFlicks, type Keyframe, type PerformanceFit, type PerformanceTake, type TimeRange } from '@motion/engine-api';
import type { TakeSample } from './fitTake';

/** The most samples one take may hold — 10 minutes at 60 Hz (the engine refuses more). */
export const MAX_TAKE_SAMPLES = 36_000;

/** The compact wire shape: times once, values flattened `dims` per sample. */
export interface PackedSamples {
  dims: number;
  times: number[];
  values: number[];
}

/**
 * Pack samples (comp seconds, one value per dimension). The dimension count
 * is the first sample's; a sample with fewer values is padded with zeros,
 * one with more is cut, so the record always parses.
 */
export function packSamples(samples: readonly TakeSample[]): PackedSamples {
  const dims = Math.max(1, samples[0]?.v.length ?? 1);
  const times: number[] = [];
  const values: number[] = [];
  for (const s of samples) {
    times.push(s.t);
    for (let i = 0; i < dims; i++) values.push(s.v[i] ?? 0);
  }
  return { dims, times, values };
}

/** The samples back from the record (comp seconds). */
export function unpackSamples(take: Pick<PerformanceTake, 'dims' | 'times' | 'values'>): TakeSample[] {
  const dims = Math.max(1, take.dims);
  const out: TakeSample[] = [];
  for (let i = 0; i < take.times.length; i++) {
    const v: number[] = [];
    for (let d = 0; d < dims; d++) v.push(take.values[i * dims + d] ?? 0);
    out.push({ t: take.times[i]!, v });
  }
  return out;
}

/** The comp-time range of the keys a take wrote, from their times in comp seconds (empty when there are none). */
export function takeSpan(keyTimes: readonly number[]): TimeRange {
  if (keyTimes.length === 0) return { start: 0, duration: 0 };
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of keyTimes) {
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  const start = secondsToFlicks(lo);
  return { start, duration: Math.max(0, secondsToFlicks(hi) - start) };
}

/**
 * The keys of a track a re-fit keeps: those outside the take's span (a flick
 * of slack each side, as the recorders' own rebuild allows). The keys inside
 * it are the take's — the re-fit replaces them.
 */
export function keysOutsideSpan(keys: readonly Keyframe[], span: TimeRange): Keyframe[] {
  const t0 = span.start;
  const t1 = span.start + span.duration;
  return keys.filter((k) => k.time < t0 - 1 || k.time > t1 + 1);
}

export interface TakeRecordInput {
  layer: string;
  path: string;
  /** What recorded the take: mouse | hand | … */
  source: string;
  /** The raw samples, comp seconds, BEFORE capture speed. */
  samples: readonly TakeSample[];
  fit: PerformanceFit;
  /** The times of the keys the take wrote, comp seconds. */
  keyTimes: readonly number[];
}

/**
 * The take as the document stores it, or null when it cannot be stored: no
 * samples, or more than `MAX_TAKE_SAMPLES` (the keys are still written; the
 * caller says the take itself was not kept).
 */
export function performanceTakeOf(input: TakeRecordInput): PerformanceTake | null {
  if (input.samples.length === 0 || input.samples.length > MAX_TAKE_SAMPLES) return null;
  const packed = packSamples(input.samples);
  return {
    layer: input.layer,
    path: input.path,
    source: input.source,
    dims: packed.dims,
    times: packed.times,
    values: packed.values,
    fit: input.fit,
    span: takeSpan(input.keyTimes),
  };
}
