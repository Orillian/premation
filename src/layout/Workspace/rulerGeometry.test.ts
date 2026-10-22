/**
 * The ruler you can SEE and the ruler you can GRAB must be the same ruler.
 *
 * They were not. `paintRulers` drew a 22 CSS-px bar pinned to the viewport's
 * top and left edges; `rulerStrips` hit-tested a 16-DEVICE-px band hugging the
 * composition frame, left over from a backend that had been deleted. Pressing
 * the visible bar did nothing, and an invisible band that moved with pan and
 * zoom dragged the guides out instead.
 *
 * These assertions are written against the DRAWN bar — origin (0,0), thickness
 * RULER_CSS_PX, pinned to the viewport — so a painter that moves without the
 * hit-test (or the reverse) fails here rather than in someone's hands.
 */

import {
  RULER_CSS_PX,
  RULER_MIN_LABEL_PX,
  RULER_MIN_TICK_PX,
  formatRulerValue,
  inRulerCorner,
  inStrip,
  rulerSteps,
  rulerStrips,
  toRulerValue,
} from './rulerGeometry';

const W = 1200;
const H = 800;

describe('ruler strips match the drawn bar', () => {
  const { top, left } = rulerStrips(W, H);

  it('the top strip spans the viewport width at the viewport top', () => {
    expect(top.y).toBe(0);
    expect(top.height).toBe(RULER_CSS_PX);
    // Starts after the corner, runs to the right edge.
    expect(top.x).toBe(RULER_CSS_PX);
    expect(top.x + top.width).toBe(W);
  });

  it('the left strip spans the viewport height at the viewport left', () => {
    expect(left.x).toBe(0);
    expect(left.width).toBe(RULER_CSS_PX);
    expect(left.y).toBe(RULER_CSS_PX);
    expect(left.y + left.height).toBe(H);
  });

  it('a press anywhere on the drawn top bar hits the top strip', () => {
    for (const x of [RULER_CSS_PX, 100, W / 2, W - 1]) {
      expect({ x, hit: inStrip(top, { x, y: RULER_CSS_PX / 2 }) }).toEqual({ x, hit: true });
    }
  });

  it('a press anywhere on the drawn left bar hits the left strip', () => {
    for (const y of [RULER_CSS_PX, 100, H / 2, H - 1]) {
      expect({ y, hit: inStrip(left, { x: RULER_CSS_PX / 2, y }) }).toEqual({ y, hit: true });
    }
  });

  it('the corner square belongs to neither strip — a press there has no axis', () => {
    const corner = { x: RULER_CSS_PX / 2, y: RULER_CSS_PX / 2 };
    expect({ top: inStrip(top, corner), left: inStrip(left, corner) })
      .toEqual({ top: false, left: false });
  });

  it('the canvas below and right of the bars is not a ruler', () => {
    const onCanvas = { x: RULER_CSS_PX + 40, y: RULER_CSS_PX + 40 };
    expect({ top: inStrip(top, onCanvas), left: inStrip(left, onCanvas) })
      .toEqual({ top: false, left: false });
  });

  it('does not depend on pan, zoom or composition size', () => {
    // The old implementation derived the strips from worldToScreen of the comp
    // corners, so every one of these would have moved the grab region. The bar
    // is viewport chrome: same place at any view.
    expect(rulerStrips(W, H)).toEqual(rulerStrips(W, H));
  });

  it('degenerates safely on a viewport smaller than the bar', () => {
    const tiny = rulerStrips(10, 10);
    expect(tiny.top.width).toBe(0);
    expect(tiny.left.height).toBe(0);
  });
});

describe('ruler ticks, units and origin (AE rulers)', () => {
  it('walks the 1-2-5 series: labels never closer than the minimum', () => {
    for (const ppu of [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 3.3, 8, 16, 64]) {
      const s = rulerSteps(ppu);
      expect(s.major * ppu).toBeGreaterThanOrEqual(RULER_MIN_LABEL_PX - 1e-6);
      const lead = s.major / 10 ** Math.floor(Math.log10(s.major) + 1e-9);
      expect([1, 2, 5]).toContain(Math.round(lead));
      // The next step down would have crowded the labels.
      expect(s.major * ppu).toBeLessThan(RULER_MIN_LABEL_PX * 2.5 + 1e-6);
    }
  });

  it('at 100% a labelled tick every 100 px, tenths between them', () => {
    expect(rulerSteps(1)).toEqual({ major: 100, minor: 10, subdivisions: 10 });
  });

  it('thins the minor ticks before they crowd', () => {
    for (const ppu of [0.03, 0.4, 0.7, 1.3, 5]) {
      const s = rulerSteps(ppu);
      if (s.subdivisions > 1) expect(s.minor * ppu).toBeGreaterThanOrEqual(RULER_MIN_TICK_PX);
    }
  });

  it('labels whole numbers whole and fractions only as deep as the step', () => {
    expect(formatRulerValue(1200, 100)).toBe('1200');
    expect(formatRulerValue(-50, 50)).toBe('-50');
    expect(formatRulerValue(2.5, 0.5)).toBe('2.5');
    expect(formatRulerValue(1e-12, 0.1)).toBe('0.0');
  });

  it('reads from the origin, in pixels or percent of the side', () => {
    expect(toRulerValue(960, 0, 'px', 1920)).toBe(960);
    expect(toRulerValue(960, 960, 'px', 1920)).toBe(0);
    expect(toRulerValue(960, 0, 'percent', 1920)).toBe(50);
    expect(toRulerValue(0, 960, 'percent', 1920)).toBe(-50);
  });

  it('the corner is the zero-point handle, and neither strip', () => {
    const { top, left } = rulerStrips(W, H);
    const p = { x: RULER_CSS_PX / 2, y: RULER_CSS_PX / 2 };
    expect(inRulerCorner(p)).toBe(true);
    expect(inStrip(top, p) || inStrip(left, p)).toBe(false);
    expect(inRulerCorner({ x: RULER_CSS_PX + 1, y: 2 })).toBe(false);
  });
});
