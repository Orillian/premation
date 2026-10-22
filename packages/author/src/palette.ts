/**
 * The palette engine's checks (the concept stage): the swatches a concept
 * proposes are hex colours the model wrote, and a model writes "a text colour
 * that reads" far more easily than one that does. These are the sums.
 *
 *  - `contrastRatio` — WCAG 2 relative-luminance contrast, 1 (same) to 21.
 *  - `ensureReadable` — a swatch list whose LAST swatch (the text colour, by
 *    the concept schema's convention) reads on its FIRST (the background) at
 *    4.5:1 or better: the text colour is pushed towards white or black, in
 *    steps, until it does. The accent and surfaces are left alone — they are
 *    a look, not a legibility guarantee.
 *
 * Pure; the hex parsing is shared with variety.ts through `luminance`.
 */

const HEX = /^#([0-9a-f]{6})$/i;

function parse(hex: string): [number, number, number] | null {
  const m = HEX.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance: sRGB channels linearised, then weighted. */
function relativeLuminance(hex: string): number | null {
  const c = parse(hex);
  if (!c) return null;
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** The WCAG 2 contrast ratio of two hex colours (1–21). Unparseable = 1. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return 1;
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

function toHex(r: number, g: number, b: number): string {
  const c = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Mix `hex` towards white (`t` > 0) or black (`t` < 0) by |t| (0–1). */
function pushed(hex: string, t: number): string {
  const c = parse(hex);
  if (!c) return hex;
  const target = t > 0 ? 255 : 0;
  const k = Math.min(1, Math.abs(t));
  return toHex(c[0] + (target - c[0]) * k, c[1] + (target - c[1]) * k, c[2] + (target - c[2]) * k);
}

/** The ratio text should reach on its background (WCAG AA for body text). */
export const READABLE_RATIO = 4.5;

/**
 * `swatches` with its last entry made to read on its first (see the module
 * header). A list with fewer than two swatches, or with an unparseable
 * background, comes back as it was. Returns the same array when nothing moved.
 */
export function ensureReadable(swatches: readonly string[], minRatio = READABLE_RATIO): string[] {
  if (swatches.length < 2) return [...swatches];
  const bg = swatches[0]!;
  const text = swatches[swatches.length - 1]!;
  if (!parse(bg) || !parse(text)) return [...swatches];
  if (contrastRatio(bg, text) >= minRatio) return [...swatches];
  // Push the text colour away from the background's side: light backgrounds
  // get a darker text, dark backgrounds a lighter one.
  const dir = (relativeLuminance(bg) ?? 0) > 0.3 ? -1 : 1;
  let out = text;
  for (let step = 0.15; step <= 1; step += 0.15) {
    out = pushed(text, dir * step);
    if (contrastRatio(bg, out) >= minRatio) break;
  }
  // The brute end of the scale always reads on any background.
  if (contrastRatio(bg, out) < minRatio) out = dir > 0 ? '#ffffff' : '#000000';
  return [...swatches.slice(0, -1), out];
}

/** Only well-formed 6-digit hex swatches, lower-cased, at most five. */
export function cleanSwatches(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const s = v.trim().toLowerCase();
    if (HEX.test(s) && !out.includes(s)) out.push(s);
    if (out.length === 5) break;
  }
  return out;
}
