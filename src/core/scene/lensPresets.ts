/**
 * The camera lens presets — ONE list for every place a lens is picked
 * (camera program U2, 2026-10-14).
 *
 * The Inspector's "Lens Presets ▸" menu used to keep its own list of six
 * angles of view and the New Camera dialog its own list of nine millimetre
 * lengths, so a 20mm camera made in the dialog read as "Custom" in the
 * Inspector and the two could never agree on what a lens was called. The
 * list lives here, in millimetres — the unit a camera operator thinks in —
 * and both consumers derive the angle of view and the stored Zoom from it.
 *
 * ## The three units of one lens
 *
 *   mm      the focal length on a 36mm-wide film back (AE's default Film Size)
 *   fov     the HORIZONTAL angle of view: 2·atan(filmSize / 2 / mm)
 *   px      the stored Zoom (`focalLength`), in comp px: the distance at which
 *           a layer renders 1:1 — `Project3D.focalLengthForFov(compWidth, fov)`
 *
 * Substituting the first into the second gives px = compWidth · mm / filmSize:
 * the comp width plays the film back. The helpers go through the angle anyway
 * (and through `Project3D`), so they can never disagree with the renderer.
 */

import { Project3D } from '@motion/scene';
import { t } from '@core/i18n';

/** AE's default virtual sensor width (35mm full frame), mm. */
export const DEFAULT_FILM_SIZE_MM = 36;

export interface LensPreset {
  /** Focal length on a {@link DEFAULT_FILM_SIZE_MM} film back. */
  mm: number;
  /** What the menus show: "35mm — Reportage". */
  label: string;
}

/** AE's New Camera lens list, short to long. */
export const LENS_PRESETS: ReadonlyArray<LensPreset> = [
  { mm: 15, get label() { return t('core.lens.n15mmUltraWide', '15mm — Ultra Wide'); } },
  { mm: 20, get label() { return t('core.lens.n20mmSuperWide', '20mm — Super Wide'); } },
  { mm: 24, get label() { return t('core.lens.n24mmWide', '24mm — Wide'); } },
  { mm: 28, get label() { return t('core.lens.n28mmModerateWide', '28mm — Moderate Wide'); } },
  { mm: 35, get label() { return t('core.lens.n35mmReportage', '35mm — Reportage'); } },
  { mm: 50, get label() { return t('core.lens.n50mmStandard', '50mm — Standard'); } },
  { mm: 80, get label() { return t('core.lens.n80mmPortrait', '80mm — Portrait'); } },
  { mm: 135, get label() { return t('core.lens.n135mmTele', '135mm — Tele'); } },
  { mm: 200, get label() { return t('core.lens.n200mmLongTele', '200mm — Long Tele'); } },
];

/** The lens the New Camera dialog opens on. */
export const DEFAULT_LENS_MM = 50;

/** Horizontal angle of view (deg) of an `mm` lens on a `filmSize` film back. */
export function fovForMm(mm: number, filmSize = DEFAULT_FILM_SIZE_MM): number {
  return (2 * Math.atan(filmSize / 2 / Math.max(1e-6, mm)) * 180) / Math.PI;
}

/** The focal length (mm) that gives a horizontal angle of view of `fovDeg`. */
export function mmForFov(fovDeg: number, filmSize = DEFAULT_FILM_SIZE_MM): number {
  return filmSize / (2 * Math.tan((fovDeg * Math.PI) / 360));
}

/** The stored Zoom (comp px) of an `mm` lens over a comp `compWidth` wide. */
export function focalPxForMm(compWidth: number, mm: number, filmSize = DEFAULT_FILM_SIZE_MM): number {
  return Project3D.focalLengthForFov(compWidth, fovForMm(mm, filmSize));
}

/** The lens (mm) a stored Zoom of `focalPx` reads as over a comp `compWidth` wide. */
export function mmForFocalPx(compWidth: number, focalPx: number, filmSize = DEFAULT_FILM_SIZE_MM): number {
  return mmForFov(Project3D.fovForFocalLength(compWidth, focalPx), filmSize);
}

/**
 * The preset a camera's Zoom matches, or null ("Custom"). Matched in mm with
 * half a millimetre of slack: a Zoom typed or rounded to whole px (every
 * preset pick stores `Math.round(px)`) still reads as its lens, and two
 * presets are never closer than 4mm apart.
 */
export function lensPresetForFocalPx(compWidth: number, focalPx: number): LensPreset | null {
  const mm = mmForFocalPx(compWidth, focalPx);
  return LENS_PRESETS.find((p) => Math.abs(p.mm - mm) < 0.5) ?? null;
}
