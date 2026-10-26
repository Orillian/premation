/**
 * The graph editor's VALUE axis as something you can zoom and pan — After
 * Effects' vertical zoom (Alt + wheel), vertical pan (Shift + wheel, middle
 * drag) and the two "fit" buttons in its footer.
 *
 * ## Why this is a layer over the auto-fit, not a replacement for it
 *
 * Every curve starts fitted to its own data (`normalizedRange`); that fit is
 * recomputed on every sample that lands. A manual view must survive those
 * re-fits — a graph that snapped back to auto-fit on the next engine answer
 * would undo the zoom you just made — so the editor keeps a MANUAL range per
 * curve (or one for the shared axis) that, while set, replaces the fit. Fit
 * clears it. Everything here is pure: the maps between a wheel tick / a drag
 * and the resulting range are unit-tested without React or the engine.
 *
 * All operations are expressed on one range and applied to every plotted
 * curve with the same screen-space parameters (cursor y, pixel delta): with
 * per-curve axes the curves then zoom and pan TOGETHER as the picture you see,
 * which is what a vertical zoom means when the axes differ.
 */

import { normalizedRange } from './graphNormalize';
import { yToValue } from './graphReferenceCurve';

export interface ValueRange {
  minV: number;
  maxV: number;
}

/** One wheel tick scales the visible span by this much (matches the time axis). */
export const VALUE_ZOOM_STEP = 1.15;
/** The visible span never collapses below this or grows past the other bound — a stuck axis is unrecoverable by wheel. */
const MIN_SPAN = 1e-6;
const MAX_SPAN = 1e12;

/**
 * Zoom the range about the value under svg `cy` (the pointer), by `factor`
 * (< 1 zooms in). The value under the cursor stays under the cursor.
 */
export function zoomValueRange(range: ValueRange, cy: number, innerH: number, factor: number): ValueRange {
  const span = range.maxV - range.minV;
  if (!(span > 0) || !(innerH > 0) || !(factor > 0)) return range;
  const nextSpan = span * factor;
  if (nextSpan < MIN_SPAN || nextSpan > MAX_SPAN) return range;
  const anchor = yToValue(cy, range.minV, range.maxV, innerH);
  return {
    minV: anchor - (anchor - range.minV) * factor,
    maxV: anchor + (range.maxV - anchor) * factor,
  };
}

/**
 * Pan the range by `dyPx` screen pixels: positive moves the CONTENT down (the
 * pointer dragging the curves with it), so the values shown shrink.
 */
export function panValueRange(range: ValueRange, dyPx: number, innerH: number): ValueRange {
  const span = range.maxV - range.minV;
  if (!(span > 0) || !(innerH > 0) || !Number.isFinite(dyPx) || dyPx === 0) return range;
  // y grows downward: showing the content lower means larger values at a given y.
  const dv = (dyPx / innerH) * span;
  return { minV: range.minV + dv, maxV: range.maxV + dv };
}

/** The range that fits `values` — the same padding rule as the auto-fit, or null with nothing to fit. */
export function fitValueRange(values: ReadonlyArray<number>, mode: 'value' | 'speed'): ValueRange | null {
  if (!values.some((v) => Number.isFinite(v))) return null;
  return normalizedRange(values, mode);
}

/**
 * The time span (comp seconds) a fit-to-selection should show: the keys'
 * extent padded 15 % either side, or null when the selection has no span
 * (one key, or none) — a zero-width span is not a zoom, and the vertical fit
 * alone is what such a selection asks for.
 */
export function fitTimeSpan(times: ReadonlyArray<number>): { t0: number; t1: number } | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of times) {
    if (!Number.isFinite(t)) continue;
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  if (!(hi > lo)) return null;
  const pad = (hi - lo) * 0.15;
  return { t0: Math.max(0, lo - pad), t1: hi + pad };
}
