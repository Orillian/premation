// Build the chrome icon tables from a REAL pixel-grid icon family.
//
//   node scripts/icons/generate-pixel-icons.cjs src/components/Icon/pixelIcons.generated.ts
//   (npm run icons:pixel)
//
// Source: Microsoft Fluent System Icons (@fluentui/svg-icons, MIT), the
// "regular" weight, which is drawn natively on a 16-unit grid and on a
// 20-unit grid with 1 px outlines. We take the 16 set for rows, switches and
// panel chrome and the 20 set for the tool bar, and draw each at exactly its
// own grid size — no scaling, no optical resizing, no snapping of our own, so
// every glyph is pixel-perfect by construction and the whole set shares one
// weight. The handful of glyphs Fluent lacks (magnet, and a 16 px eraser and
// move) come from VS Code Codicons (@vscode/codicons, MIT), also a 16-grid,
// 1 px family.
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..');
const FLUENT = path.join(ROOT, 'node_modules', '@fluentui', 'svg-icons', 'icons');
const CODICONS = path.join(ROOT, 'node_modules', '@vscode', 'codicons', 'src', 'icons');
// Measured ink extent (max of width / height, px) of each glyph's own drawing
// at the 20 and 24 grids - getBBox in the running app (2026-10-26). The tool
// bar box (lg) takes whichever grid lands nearer INK_TARGET, so a T, a square
// or three dots read the same size as a circle or a cube beside them: the
// owner's rule that same-size boxes are not same-size icons. Rows keep 16.
const INK_TARGET = 16.5;
const INK = {
  'mouse-pointer': [16, 20], hand: [16, 20], 'zoom-in': [15, 19], 'zoom-out': [15, 19], orbit: [18, 0], rotate: [14, 18],
  'pan-behind': [16, 20], square: [14, 18], circle: [16, 20], star: [16, 20], pen: [16, 20], type: [14, 16], brush: [16, 20],
  eraser: [16, 20], 'puppet-pin': [15, 18.9], magnet: [15, 18], search: [15, 19], composition: [16, 20], video: [16, 20],
  solid: [15.9, 19.9], audio: [16, 20], 'audio-off': [16, 20], shape: [16, 20], adjustment: [16, 20.1], camera: [16, 20],
  light: [16, 20], 'folder-plus': [17, 21], trash: [16.5, 20.5], menu: [16, 20.1], close: [12, 15.5], 'chevron-down': [12.1, 16],
  'chevron-up': [12, 16], 'chevron-left': [12, 16], 'chevron-right': [12, 16], grid: [16, 18], eye: [15.5, 19.4], 'eye-off': [16, 20],
  lock: [17, 21], unlock: [17, 21], stopwatch: [16, 19.5], keyframe: [18, 22], 'skip-back': [14, 18], 'skip-forward': [14, 18],
  loop: [16, 20.1], 'motion-blur': [16, 18], shy: [16, 20], '3d': [16, 20], 'draft-3d': [14, 18], 'graph-value': [16, 20],
  'graph-speed': [16, 18], marker: [16, 19], 'align-left': [16, 20], 'align-center': [16, 20], 'align-right': [16, 20],
  'align-top': [16, 20], 'align-middle': [16, 20], 'align-bottom': [16, 20], 'distribute-horizontal': [0, 0], 'distribute-vertical': [0, 0],
  'mask-square': [14, 18], 'mask-circle': [16, 20], 'mask-pen': [14, 18], 'mask-feather': [16, 20], undo: [16, 20], redo: [16, 20],
  'gizmo-universal': [16, 20], 'gizmo-position': [16, 20], 'gizmo-scale': [14, 18], 'gizmo-rotation': [14, 18], 'axis-local': [16, 20],
  'axis-world': [16, 20], 'axis-view': [15.5, 19.4], cube: [16.9, 0], 'layer-plus': [14, 18], 'magic-wand': [16, 18.9],
  'more-horizontal': [12.5, 15.5], 'pan-camera': [16, 20], perspective: [14, 18], 'ground-grid': [14, 17],
};
function lgGrid(n) {
  const [at20, at24] = INK[n] ?? [16, 0];
  if (!at24) return 20;
  return Math.abs(at24 - INK_TARGET) < Math.abs(at20 - INK_TARGET) ? 24 : 20;
}

// chrome name → Fluent glyph name (regular weight). A `{16, 20}` object names a
// different glyph per grid; a `codicon:` prefix takes the glyph from Codicons
// (16-grid; scaled 1.25× onto the 20 grid, the one place a glyph is scaled).
const MAP = {
  'mouse-pointer': 'cursor',
  'hand': 'hand_left',
  'zoom-in': 'zoom_in',
  'zoom-out': 'zoom_out',
  'orbit': { 16: 'space_3d', 20: 'cube_rotate' },
  'rotate': 'arrow_rotate_clockwise',
  'pan-behind': { 16: 'codicon:move', 20: 'arrow_move' },
  'square': 'square',
  'circle': 'circle',
  'star': 'star',
  'pen': 'pen',
  'type': 'text_t',
  'brush': 'paint_brush',
  'eraser': { 16: 'codicon:eraser', 20: 'eraser_tool' },
  'puppet-pin': 'pin',
  'magnet': 'codicon:magnet',
  'search': 'search',
  'composition': 'rectangle_landscape',
  'video': 'video',
  'solid': 'color',
  'audio': 'speaker_2',
  'audio-off': 'speaker_mute',
  'shape': 'shapes',
  'adjustment': 'options',
  'camera': 'camera',
  'light': 'lightbulb',
  'folder-plus': 'folder_add',
  'trash': 'delete',
  'menu': 'navigation',
  'close': 'dismiss',
  'chevron-down': 'chevron_down',
  'chevron-up': 'chevron_up',
  'chevron-left': 'chevron_left',
  'chevron-right': 'chevron_right',
  'grid': 'grid',
  'eye': 'eye',
  'eye-off': 'eye_off',
  'lock': 'lock_closed',
  'unlock': 'lock_open',
  'stopwatch': 'timer',
  'keyframe': 'diamond',
  'skip-back': 'previous',
  'skip-forward': 'next',
  'loop': 'arrow_repeat_all',
  'motion-blur': 'blur',
  'shy': 'person',
  '3d': 'cube',
  'draft-3d': 'space_3d',
  'graph-value': 'data_line',
  'graph-speed': 'data_trending',
  'marker': 'bookmark',
  'align-left': 'align_left',
  'align-center': 'align_center_horizontal',
  'align-right': 'align_right',
  'align-top': 'align_top',
  'align-middle': 'align_center_vertical',
  'align-bottom': 'align_bottom',
  'distribute-horizontal': 'align_distribute_left',
  'distribute-vertical': 'align_distribute_top',
  // The tool bar's right side and the scene-control strip (owner, 2026-10-26:
  // one family across the whole bar, the AE mask / gizmo / axis / undo marks).
  'mask-square': 'square_hint',
  'mask-circle': 'circle_hint',
  'mask-pen': 'select_object',
  'mask-feather': 'circle_half_fill',
  'undo': 'arrow_undo',
  'redo': 'arrow_redo',
  'gizmo-universal': 'select_object_skew',
  'gizmo-position': { 16: 'codicon:move', 20: 'arrow_move' },
  'gizmo-scale': 'resize',
  'gizmo-rotation': 'arrow_rotate_counterclockwise',
  'axis-local': 'cube',
  'axis-world': 'globe',
  'axis-view': 'eye',
  'cube': { 16: 'cube', 20: 'cube_add' },
  'layer-plus': 'add_square_multiple',
  'magic-wand': 'wand',
  'more-horizontal': 'more_horizontal',
  'pan-camera': 'hand_left',
  'perspective': 'arrow_expand',
  'ground-grid': 'grid_dots',
};

function body(file) {
  const s = fs.readFileSync(file, 'utf8');
  return s.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
}
function glyph(spec, size) {
  const name = typeof spec === 'string' ? spec : spec[size];
  if (name.startsWith('codicon:')) {
    const b = body(path.join(CODICONS, name.slice(8) + '.svg'));
    return size === 16 ? b : `<g transform="scale(${size / 16})">${b}</g>`;
  }
  if (typeof spec !== 'string' && !spec[size] && size === 24) {
    // A per-grid spec names 16 and 20 only; the 24 grid takes the 20 name.
    return glyph(spec[20], size);
  }
  const file = path.join(FLUENT, `${name}_${size}_regular.svg`);
  if (fs.existsSync(file)) return body(file);
  // Fluent draws a few glyphs (the distribute pair) at 16 and 24 only; the
  // 20 grid, which the chrome never uses for them, takes the 16 drawing scaled.
  const at16 = path.join(FLUENT, `${name}_16_regular.svg`);
  if (size !== 16 && fs.existsSync(at16)) return `<g transform="scale(${size / 16})">${body(at16)}</g>`;
  throw new Error(`Fluent has no ${name} at ${size}`);
}

const out = process.argv[2];
if (!out) throw new Error('usage: generate-pixel-icons.cjs <out.ts>');
let ts = `/**
 * GENERATED FILE — do not edit by hand. Source: Microsoft Fluent System Icons
 * (@fluentui/svg-icons, regular weight, MIT) with three glyphs from VS Code
 * Codicons (@vscode/codicons, MIT), through scripts/icons/generate-pixel-icons.cjs
 * (npm run icons:pixel). Each glyph is the family's own 16-grid drawing for
 * rows, switches and panel chrome, and its own 20-grid drawing for the tool
 * bar; Icon.tsx draws each at exactly that size, so no glyph is ever scaled.
 */
import type { IconName } from './iconNames';

/** One drawing: the grid it is drawn on (also its box in px) and its markup. */
export interface PixelGlyph { px: 16 | 20 | 24; m: string }

/** sm: rows, switches, panel chrome (16 grid). lg: the tool bar (20 or 24 grid, by ink). */
export const PIXEL_ICONS: Partial<Record<IconName, { sm: PixelGlyph; lg: PixelGlyph }>> = {
`;
for (const [n, spec] of Object.entries(MAP)) {
  const lg = lgGrid(n);
  ts += `  '${n}': {\n`;
  ts += `    sm: { px: 16, m: '${glyph(spec, 16).replace(/'/g, "\\'")}' },\n`;
  ts += `    lg: { px: ${lg}, m: '${glyph(spec, lg).replace(/'/g, "\\'")}' },\n`;
  ts += `  },\n`;
}
ts += `};\n`;
fs.writeFileSync(out, ts.replace(/\r?\n/g, '\r\n'));
console.log('generated', Object.keys(MAP).length, 'glyphs;', Object.keys(MAP).filter((n) => lgGrid(n) === 24).length, 'on the 24 grid in the tool bar');
