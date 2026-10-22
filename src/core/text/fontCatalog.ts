/**
 * Font catalog — per-family WEIGHTS discovered from the real installed fonts
 * (queryLocalFonts styles), so the Weight dropdown offers what a family
 * actually ships instead of a hardcoded 300–700 guess. Cached module-wide;
 * families we know nothing about fall back to the standard five.
 */

import { fontFamilyInfo } from '@core/fonts/engineFontList';
import { t } from '@core/i18n';

interface LocalFontData {
  family?: string;
  style?: string;
}

/** Style-name → numeric weight. ORDER MATTERS: compound names (Extra Bold,
 *  Semi Bold) must match before their plain substrings (Bold). */
const STYLE_WEIGHTS: ReadonlyArray<readonly [RegExp, number]> = [
  [/thin|hairline/i, 100],
  [/extra\s*-?light|ultra\s*-?light/i, 200],
  [/semi\s*-?bold|demi\s*-?bold|demibold/i, 600],
  [/extra\s*-?bold|ultra\s*-?bold/i, 800],
  [/light/i, 300],
  [/medium/i, 500],
  [/black|heavy/i, 900],
  [/bold/i, 700],
  [/regular|normal|book|roman|text|italic|oblique/i, 400],
];

export function weightFromStyle(style: string): number {
  for (const [re, w] of STYLE_WEIGHTS) {
    if (re.test(style)) return w;
  }
  return 400;
}

export const FALLBACK_WEIGHTS: readonly number[] = [300, 400, 500, 600, 700];

export const WEIGHT_LABELS: Record<number, string> = {
  get 100() { return t('core.fontCatalog.weightThin', 'Thin (100)'); },
  get 200() { return t('core.fontCatalog.weightExtraLight', 'Extra Light (200)'); },
  get 300() { return t('core.fontCatalog.weightLight', 'Light (300)'); },
  get 400() { return t('core.fontCatalog.weightRegular', 'Regular (400)'); },
  get 500() { return t('core.fontCatalog.weightMedium', 'Medium (500)'); },
  get 600() { return t('core.fontCatalog.weightSemiBold', 'Semi-Bold (600)'); },
  get 700() { return t('core.fontCatalog.weightBold', 'Bold (700)'); },
  get 800() { return t('core.fontCatalog.weightExtraBold', 'Extra Bold (800)'); },
  get 900() { return t('core.fontCatalog.weightBlack', 'Black (900)'); },
};

let catalog: Map<string, Set<number>> | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Kick off (once) the local-font scan; notifies subscribers when ready. */
export function loadFontCatalog(): Promise<void> {
  if (catalog) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    const map = new Map<string, Set<number>>();
    try {
      const query = (window as unknown as {
        queryLocalFonts?: () => Promise<ReadonlyArray<LocalFontData>>;
      }).queryLocalFonts;
      if (typeof query === 'function') {
        for (const f of (await query.call(window)) ?? []) {
          const family = String(f?.family ?? '').trim();
          if (!family) continue;
          let set = map.get(family);
          if (!set) {
            set = new Set<number>();
            map.set(family, set);
          }
          set.add(weightFromStyle(String(f?.style ?? 'Regular')));
        }
      }
    } catch {
      /* permission denied / unsupported — fallbacks cover it */
    }
    catalog = map;
    for (const l of listeners) l();
  })();
  return loading;
}

/** Subscribe to catalog readiness (for React re-render). */
export function onFontCatalogReady(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The weights a family actually provides, sorted ascending: what the engine
 * draws (engineFontList — the shipped families and the installed ones, a
 * variable face's whole `wght` range), else the local-font scan. Unknown
 * families get the standard five.
 */
export function getFontWeights(family: string): number[] {
  const drawn = fontFamilyInfo(family);
  if (drawn && drawn.weights.length > 0) return [...drawn.weights];
  const found = catalog?.get(family);
  if (!found || found.size === 0) return [...FALLBACK_WEIGHTS];
  return [...new Set([...found, 400])].sort((a, b) => a - b);
}
