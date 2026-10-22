/**
 * Where the ruler bars ARE — the single geometry both the painter and the
 * hit-test read.
 *
 * Pulled out of useWorkspace.ts because the two had silently disagreed. The
 * painter (`paintRulers`) drew a 22 CSS-px bar pinned to the top and left edges
 * of the viewport; the hit-test (`rulerStrips`) still returned a 16-DEVICE-px
 * band hugging the composition frame, matching a `Canvas2DBackend.drawOverlays`
 * that no longer exists. So pressing on the visible ruler did nothing, while an
 * invisible band along the artboard edge — which moved with pan and zoom —
 * dragged guides out.
 *
 * Neither half was broken on its own, which is why it survived: both were
 * "working", in different places. A shared constant plus a test that measures
 * one against the other is what stops that recurring.
 */

/** Ruler bar thickness, CSS px. The painter and the hit-test share it. */
export const RULER_CSS_PX = 22;

export interface StripRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const inStrip = (r: StripRect, p: { x: number; y: number }): boolean =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

/**
 * The two ruler strips in overlay (CSS px) space, given the stage's CSS size.
 *
 * The corner square belongs to NEITHER strip: a press there has no unambiguous
 * axis — horizontal guide or vertical? — so both strips start after it and the
 * corner stays inert, which is also how it looks.
 */
export function rulerStrips(cssW: number, cssH: number): { top: StripRect; left: StripRect } {
  const t = RULER_CSS_PX;
  return {
    top: { x: t, y: 0, width: Math.max(0, cssW - t), height: t },
    left: { x: 0, y: t, width: t, height: Math.max(0, cssH - t) },
  };
}

/** The corner square where the rulers meet: the zero-point handle. */
export const inRulerCorner = (p: { x: number; y: number }): boolean =>
  p.x >= 0 && p.y >= 0 && p.x < RULER_CSS_PX && p.y < RULER_CSS_PX;

/** What the ruler numbers count: comp pixels, or percent of the comp's side. */
export type RulerUnit = 'px' | 'percent';

/** Comp pixels per ruler unit on an axis: 1 for pixels, side / 100 for percent. */
export function pxPerRulerUnit(unit: RulerUnit, side: number): number {
  return unit === 'percent' ? Math.max(1e-6, side / 100) : 1;
}

export interface RulerSteps {
  /** Ruler units between labelled ticks (1, 2 or 5 × 10ⁿ). */
  major: number;
  /** Ruler units between the smallest ticks. */
  minor: number;
  /** Minor ticks per major (1 = no minor ticks). */
  subdivisions: number;
}

/** Closest a labelled tick may come to the next, screen px — room for "-10000". */
export const RULER_MIN_LABEL_PX = 56;
/** Closest two minor ticks may come before they read as a grey smear. */
export const RULER_MIN_TICK_PX = 5;

/**
 * The tick spacing for a zoom: the smallest 1-2-5 step whose labels stay at
 * least RULER_MIN_LABEL_PX apart, subdivided into tenths, quarters or fifths
 * (by the step's leading digit) — coarser when those would crowd. The same
 * series After Effects' rulers walk as you zoom, so a label never jumps from
 * 100 to 300.
 */
export function rulerSteps(screenPxPerUnit: number): RulerSteps {
  const ppu = Math.max(1e-9, screenPxPerUnit);
  const want = RULER_MIN_LABEL_PX / ppu;
  const exp = Math.floor(Math.log10(want));
  let major = 0;
  for (let e = exp; major === 0; e++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e;
      if (v >= want - 1e-9) { major = v; break; }
    }
  }
  const lead = Math.round(major / 10 ** Math.floor(Math.log10(major) + 1e-9));
  const options = lead === 1 ? [10, 5, 2, 1] : lead === 2 ? [4, 2, 1] : [5, 1];
  const subdivisions = options.find((s) => (major / s) * ppu >= RULER_MIN_TICK_PX) ?? 1;
  return { major, minor: major / subdivisions, subdivisions };
}

/** A ruler label: whole numbers as is, fractions only as deep as the step needs. */
export function formatRulerValue(value: number, step: number): string {
  const decimals = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step) - 1e-9));
  const v = Math.abs(value) < 10 ** -(decimals + 1) ? 0 : value;
  return v.toFixed(decimals);
}

/** A comp coordinate as the ruler reads it: from the origin, in the unit. */
export function toRulerValue(world: number, origin: number, unit: RulerUnit, side: number): number {
  return (world - origin) / pxPerRulerUnit(unit, side);
}
