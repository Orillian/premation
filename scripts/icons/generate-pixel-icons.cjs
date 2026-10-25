// Generate optically sized, pixel-snapped glyph tables for the chrome icon set.
//
//   npm run icons:pixel   (measure with headless Electron, then generate)
//   node scripts/icons/generate-pixel-icons.cjs <bbox.json> <out.ts>
//
// For each glyph: take its 16-grid markup from drawnIcons.ts, scale it about
// the grid centre so its ink box spans the same TARGET extent as every other
// glyph (optical sizing: a chevron or an eye is drawn larger than a cube), then
// resize to each output grid (16, 24, 32) and snap every coordinate so a 1 px
// stroke sits on a half-pixel centre and every box edge on a whole pixel.
const fs = require('node:fs');
const path = require('node:path');
const [bboxFile, outFile] = process.argv.slice(2);
const src = fs.readFileSync(path.resolve('src/components/Icon/drawnIcons.ts'), 'utf8');
const bbox = JSON.parse(fs.readFileSync(bboxFile, 'utf8'));
const names = Object.keys(bbox);

// Target ink extent in 16-grid units: a square glyph spans 12 of 16; a long
// thin one (a chevron) is brought up by its longer side only, capped so a
// one-line glyph cannot balloon.
const TARGET = 12.5;
const SCALE_MIN = 0.8, SCALE_MAX = 1.35;
const SIZES = [16, 24, 32];

// ── a small SVG path transformer: M L H V C S Q T A Z, absolute and relative ──
function transformPath(d, fx, fy) {
  // fx(x), fy(y) map ABSOLUTE coordinates; relative commands get the delta form.
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g);
  let i = 0, cmd = '', out = '';
  let cx = 0, cy = 0, sx = 0, sy = 0;
  const num = () => parseFloat(toks[i++]);
  const fmt = (v) => (Math.round(v * 100) / 100).toString().replace(/^(-?)0\./, '$1.');
  const sc = (fx(1) - fx(0));
  while (i < toks.length) {
    const t = toks[i];
    if (/[a-zA-Z]/.test(t)) { cmd = t; i++; if (cmd === 'Z' || cmd === 'z') { out += 'Z'; cx = sx; cy = sy; continue; } }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const pt = (x, y) => { const ax = rel ? cx + x : x, ay = rel ? cy + y : y; return [ax, ay]; };
    if (C === 'M' || C === 'L' || C === 'T') {
      const [ax, ay] = pt(num(), num()); out += `${C}${fmt(fx(ax))} ${fmt(fy(ay))}`; cx = ax; cy = ay; if (C === 'M') { sx = ax; sy = ay; cmd = rel ? 'l' : 'L'; }
    } else if (C === 'H') { const ax = rel ? cx + num() : num(); out += `H${fmt(fx(ax))}`; cx = ax; }
    else if (C === 'V') { const ay = rel ? cy + num() : num(); out += `V${fmt(fy(ay))}`; cy = ay; }
    else if (C === 'C') { const p = []; for (let k = 0; k < 3; k++) { const [ax, ay] = pt(num(), num()); p.push(fmt(fx(ax)), fmt(fy(ay))); if (k === 2) { cx = ax; cy = ay; } } out += `C${p.join(' ')}`; }
    else if (C === 'S' || C === 'Q') { const p = []; for (let k = 0; k < 2; k++) { const [ax, ay] = pt(num(), num()); p.push(fmt(fx(ax)), fmt(fy(ay))); if (k === 1) { cx = ax; cy = ay; } } out += `${C}${p.join(' ')}`; }
    else if (C === 'A') { const rx = num(), ry = num(), rot = num(), la = num(), sw = num(); const [ax, ay] = pt(num(), num()); out += `A${fmt(rx * sc)} ${fmt(ry * sc)} ${rot} ${la} ${sw} ${fmt(fx(ax))} ${fmt(fy(ay))}`; cx = ax; cy = ay; }
    else throw new Error('cmd ' + cmd + ' in ' + d);
  }
  return out;
}

function transformMarkup(markup, fx, fy) {
  const sc = fx(1) - fx(0);
  let m = markup.replace(/ d="([^"]+)"/g, (_, d) => ` d="${transformPath(d, fx, fy)}"`);
  m = m.replace(/<circle([^>]*)\/>/g, (_, a) => {
    const g = (k) => parseFloat((a.match(new RegExp(k + '="([^"]+)"')) || [0, '0'])[1]);
    const rest = a.replace(/ (cx|cy|r)="[^"]+"/g, '');
    return `<circle cx="${f(fx(g('cx')))}" cy="${f(fy(g('cy')))}" r="${f(g('r') * sc)}"${rest}/>`;
  });
  m = m.replace(/<ellipse([^>]*)\/>/g, (_, a) => {
    const g = (k) => parseFloat((a.match(new RegExp(k + '="([^"]+)"')) || [0, '0'])[1]);
    const rest = a.replace(/ (cx|cy|rx|ry)="[^"]+"/g, '');
    return `<ellipse cx="${f(fx(g('cx')))}" cy="${f(fy(g('cy')))}" rx="${f(g('rx') * sc)}" ry="${f(g('ry') * sc)}"${rest}/>`;
  });
  m = m.replace(/<rect([^>]*)\/>/g, (_, a) => {
    const g = (k) => parseFloat((a.match(new RegExp(' ' + k + '="([^"]+)"')) || [0, '0'])[1]);
    const rest = a.replace(/ (x|y|width|height)="[^"]+"/g, '');
    const x0 = fx(g('x')), y0 = fy(g('y')), x1 = fx(g('x') + g('width')), y1 = fy(g('y') + g('height'));
    return `<rect x="${f(x0)}" y="${f(y0)}" width="${f(x1 - x0)}" height="${f(y1 - y0)}"${rest}/>`;
  });
  // dash arrays scale with the stroke grid
  m = m.replace(/stroke-dasharray="([^"]+)"/g, (_, v) => `stroke-dasharray="${v.split(/[ ,]+/).map((n) => f(parseFloat(n) * sc)).join(' ')}"`);
  return m;
}
const f = (v) => (Math.round(v * 100) / 100).toString().replace(/^(-?)0\./, '$1.');

// Snap: a stroked coordinate to a half-pixel centre; filled shapes (fill=currentColor, no stroke) to whole pixels.
function snapHalf(v) { return Math.round(v - 0.5) + 0.5; }
function snapWhole(v) { return Math.round(v); }

const out = {};
for (const n of names) {
  const m = src.match(new RegExp("^  '" + n + "': '(.*?)',$", 'm'));
  if (!m) throw new Error('no glyph ' + n);
  const markup = m[1].replace(/\\'/g, "'");
  const b = bbox[n];
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  const ext = Math.max(w, h);
  // Sub-glyphs stay their size (a chevron is a dropdown mark, not an icon); a
  // thin glyph (one dimension under half the other) is brought up only a little.
  const FIXED = { 'chevron-down': 1, 'chevron-up': 1, 'chevron-left': 1, 'chevron-right': 1, close: 1.1, menu: 1.05 };
  const thin = Math.min(w, h) < 0.5 * ext;
  const opt = FIXED[n] ?? Math.min(thin ? 1.12 : SCALE_MAX, Math.max(SCALE_MIN, TARGET / ext));
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const filled = /<g fill="currentColor" stroke="none">/.test(markup);
  out[n] = {};
  for (const S of SIZES) {
    const k = S / 16;
    const snap = filled ? snapWhole : snapHalf;
    // centre the optically scaled glyph on the output grid centre
    const fx = (x) => snap(S / 2 + (x - cx) * opt * k);
    const fy = (y) => snap(S / 2 + (y - cy) * opt * k);
    // radii must not be snapped (an arc with a snapped centre and raw radius is fine)
    const sc = opt * k;
    const fxr = (x) => S / 2 + (x - cx) * sc, fyr = (y) => S / 2 + (y - cy) * sc;
    let tm = transformMarkup(markup, fx, fy);
    // transformMarkup scales radii by (fx(1)-fx(0)); with snapping that is unstable, redo radii from the raw scale
    tm = tm.replace(/<circle cx="([^"]+)" cy="([^"]+)" r="([^"]+)"/g, (_, a, b2, r) => `<circle cx="${a}" cy="${b2}" r="${f(parseFloat(r) / (fx(1) - fx(0)) * sc)}"`)
           .replace(/<ellipse cx="([^"]+)" cy="([^"]+)" rx="([^"]+)" ry="([^"]+)"/g, (_, a, b2, rx, ry) => `<ellipse cx="${a}" cy="${b2}" rx="${f(parseFloat(rx) / (fx(1) - fx(0)) * sc)}" ry="${f(parseFloat(ry) / (fx(1) - fx(0)) * sc)}"`);
    out[n][S] = tm;
  }
  out[n].opt = Math.round(opt * 100) / 100;
}

let ts = `/**
 * GENERATED FILE — do not edit by hand. Source: drawnIcons.ts (the 16-grid chrome
 * set) through scripts/icons/generate-pixel-icons.cjs (npm run icons:pixel): each glyph optically sized (its ink box
 * brought to a common extent, so a chevron and a cube read the same size) and
 * pixel-snapped at the sizes the chrome draws it: 16 (rows, switches), 24 (the
 * tool bar), 32 (large). Strokes sit on half-pixel centres, filled edges on
 * whole pixels. Icon.tsx picks the table by the box it is given.
 */
import type { IconName } from './iconNames';

export const PIXEL_SIZES = [16, 24, 32] as const;
export type PixelSize = (typeof PIXEL_SIZES)[number];

export const PIXEL_ICONS: Partial<Record<IconName, Record<PixelSize, string>>> = {
`;
for (const n of names) {
  ts += `  '${n}': {\n`;
  for (const S of SIZES) ts += `    ${S}: '${out[n][S].replace(/'/g, "\\'")}',\n`;
  ts += `  },\n`;
}
ts += `};\n`;
fs.writeFileSync(outFile, ts);
console.log('generated', names.length, 'opt range', Math.min(...names.map((n) => out[n].opt)), Math.max(...names.map((n) => out[n].opt)));
