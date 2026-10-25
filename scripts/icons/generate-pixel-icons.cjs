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
const SIZES = [16, 20];

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

export const PIXEL_SIZES = [16, 20] as const;
export type PixelSize = (typeof PIXEL_SIZES)[number];

export const PIXEL_ICONS: Partial<Record<IconName, Record<PixelSize, string>>> = {
`;
for (const [n, spec] of Object.entries(MAP)) {
  ts += `  '${n}': {\n`;
  for (const S of SIZES) ts += `    ${S}: '${glyph(spec, S).replace(/'/g, "\\'")}',\n`;
  ts += `  },\n`;
}
ts += `};\n`;
fs.writeFileSync(out, ts.replace(/\r?\n/g, '\r\n'));
console.log('generated', Object.keys(MAP).length, 'glyphs ×', SIZES.join('/'));
