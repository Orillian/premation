/**
 * One lens list (camera program U2): mm ↔ angle of view ↔ stored Zoom (px)
 * round-trip, and every preset reads back as itself.
 */

import { Project3D } from '@motion/scene';
import {
  DEFAULT_FILM_SIZE_MM,
  LENS_PRESETS,
  focalPxForMm,
  fovForMm,
  lensPresetForFocalPx,
  mmForFocalPx,
  mmForFov,
} from './lensPresets';

const WIDTHS = [1920, 1080, 3840, 640];

describe('the shared lens list', () => {
  it('is AE\'s nine lenses in mm, short to long, labelled "<mm>mm — <name>"', () => {
    expect(LENS_PRESETS.map((p) => p.mm)).toEqual([15, 20, 24, 28, 35, 50, 80, 135, 200]);
    for (const p of LENS_PRESETS) expect(p.label).toMatch(new RegExp(`^${p.mm}mm — \\S`));
    expect(LENS_PRESETS.find((p) => p.mm === 35)?.label).toBe('35mm — Reportage');
  });
});

describe('mm ↔ fov ↔ px', () => {
  it('a 50mm lens on a 36mm back is the classic 39.6° horizontal angle', () => {
    expect(fovForMm(50)).toBeCloseTo(39.6, 1);
    expect(fovForMm(36 / 2)).toBeCloseTo(90, 9);
  });

  it('round-trips every preset through the angle of view and the stored Zoom, at any comp width', () => {
    for (const { mm } of LENS_PRESETS) {
      expect(mmForFov(fovForMm(mm))).toBeCloseTo(mm, 9);
      for (const w of WIDTHS) {
        const px = focalPxForMm(w, mm);
        // The comp width plays the film back: px = width · mm / filmSize.
        expect(px).toBeCloseTo((w * mm) / DEFAULT_FILM_SIZE_MM, 6);
        // What the renderer reads off that Zoom is the lens's own angle.
        expect(Project3D.fovForFocalLength(w, px)).toBeCloseTo(fovForMm(mm), 9);
        expect(mmForFocalPx(w, px)).toBeCloseTo(mm, 9);
      }
    }
  });

  it('honours a non-default film size', () => {
    expect(mmForFov(fovForMm(50, 24), 24)).toBeCloseTo(50, 9);
    expect(mmForFocalPx(1920, focalPxForMm(1920, 85, 24), 24)).toBeCloseTo(85, 9);
  });
});

describe('lensPresetForFocalPx', () => {
  it('names the preset a whole-px Zoom stores, and calls an off-list lens Custom (null)', () => {
    for (const w of WIDTHS) {
      for (const p of LENS_PRESETS) expect(lensPresetForFocalPx(w, Math.round(focalPxForMm(w, p.mm)))).toBe(p);
    }
    expect(lensPresetForFocalPx(1920, focalPxForMm(1920, 42))).toBeNull();
  });
});
