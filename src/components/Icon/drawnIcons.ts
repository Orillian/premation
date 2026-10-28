/**
 * Hand-drawn glyphs — the tool, 3D-scene and chrome icons.
 *
 * WHY THESE ARE NOT FROM THE SET. A tool icon has to picture the TOOL, and the
 * Material family has no pen nib with a plus, no puppet pin, no bone, no mask
 * matte; the stand-ins it offered (a bare plus for Add Vertex, scissors for the
 * Knife, a map arrow for Direct Selection) each meant something else. These are
 * drawn as one family instead, in the manner of After Effects' own tool bar.
 *
 * THE GRID. 18 x 18, which is the toolbar's `md` icon size, so one unit is one
 * pixel where these are mostly seen. 1.5 outlines with round joins (matching
 * the Material set's weight 400); solid only
 * where the object itself is solid (the selection arrow, the type T, the mask
 * mattes, gizmo handles). The wrapper <svg> in Icon.tsx supplies
 * `fill="none" stroke="currentColor" stroke-width="1.5"` and round caps and
 * joins; an element overrides those only where it differs.
 *
 * Each value is the INNER markup of that <svg>. It is authored here and never
 * built from input, which is what makes handing it to the parser as markup
 * acceptable. A name listed here is skipped by scripts/generate-sharp-icons.mjs,
 * so no Material path ships for a glyph that is never drawn — run
 * `npm run icons:generate` after adding or removing a key.
 *
 * One grade only: there is no outline/solid pair for `weight` to choose between.
 */

import type { IconName } from './iconNames';

export const DRAWN_ICON_VIEWBOX = '0 0 18 18';

const GLYPHS = {
  // Selection & navigation
  'direct-select': '<path stroke-width="1.3" d="M4.6 3.3 V13.5 L7.5 10.9 L9.7 15.6 L11 15 L8.8 10.3 H12.4 Z"/>',

  // Pen & paint
  'pencil': '<g transform="translate(-.5 .5) rotate(45 9 9)"><path d="M7 2 H11 V11.8 L9 16.4 L7 11.8 Z"/><path d="M7 4.8 H11"/><path fill="currentColor" stroke="none" d="M8.1 14 L9 16.4 L9.9 14 Z"/></g>',
  'paint': '<rect x="1.75" y="7.25" width="9.5" height="9" rx="1.2"/><g transform="translate(3.4 -3.4) scale(.8) rotate(45 9 9)" stroke-width="1.8"><path d="M8.1 1.2 H9.9 L10.5 8 H7.5 Z"/><path d="M7.1 8 H10.9 V10.3 H7.1 Z"/><path fill="currentColor" d="M7.1 10.3 C7.1 12.8 8.2 14.2 9 16.8 C9.8 14.2 10.9 12.8 10.9 10.3 Z"/></g>',
  'curvature': '<path d="M3.5 13.5 C4.5 3 13.5 3 14.5 13.5"/><rect fill="currentColor" stroke="none" x="2" y="12" width="3" height="3"/><rect fill="currentColor" stroke="none" x="13" y="12" width="3" height="3"/><circle cx="9" cy="5.6" r="1.6" fill="currentColor"/>',
  'add-vertex': '<g transform="translate(-0.6 2.6) scale(.84) rotate(45 9 9)" stroke-width="1.75"><path d="M9 16.2 L5.5 9.8 L6.9 5.2 H11.1 L12.5 9.8 Z"/><path d="M9 16.2 V11"/><circle cx="9" cy="9.7" r="1.15"/><path d="M6.9 5.2 V2.6 H11.1 V5.2"/></g><path d="M14 1.9 V6.9 M11.5 4.4 H16.5"/>',
  'delete-vertex': '<g transform="translate(-0.6 2.6) scale(.84) rotate(45 9 9)" stroke-width="1.75"><path d="M9 16.2 L5.5 9.8 L6.9 5.2 H11.1 L12.5 9.8 Z"/><path d="M9 16.2 V11"/><circle cx="9" cy="9.7" r="1.15"/><path d="M6.9 5.2 V2.6 H11.1 V5.2"/></g><path d="M11.5 4.4 H16.5"/>',
  'convert-vertex': '<path d="M2.6 15 L9 4.4 C12.2 4.4 15.4 8.4 15.4 15"/><path d="M4.6 4.4 H13.4" stroke-width="1.1"/><circle cx="4.6" cy="4.4" r="1" fill="currentColor" stroke="none"/><circle cx="13.4" cy="4.4" r="1" fill="currentColor" stroke="none"/><rect fill="currentColor" stroke="none" x="7.3" y="2.7" width="3.4" height="3.4"/>',
  'mask-feather': '<circle cx="9" cy="9" r="3.1" fill="currentColor"/><circle cx="9" cy="9" r="6.6" stroke-dasharray="1.6 2.55" stroke-width="1.4"/>',
  'knife': '<path d="M14.8 2.2 C15.6 7.2 13.2 11.2 8.6 13.4 L6.6 11.4 Z"/><path d="M7.4 12.6 L3.6 16.4" stroke-width="2.6"/>',

  // Type & shapes
  'type-vertical': '<path fill="currentColor" stroke="none" d="M1.8 3 H10.2 V5.9 H8.9 V4.5 H6.8 V13.5 H8.3 V15 H3.7 V13.5 H5.2 V4.5 H3.1 V5.9 H1.8 Z"/><path d="M14 3 V14.4 M11.8 12 L14 14.6 L16.2 12"/>',
  'polygon': '<path d="M9.00 2.80 L15.56 7.57 L13.06 15.28 L4.94 15.28 L2.44 7.57 Z"/>',
  'line': '<path d="M4 14 L14 4"/><rect fill="currentColor" stroke="none" x="2.3" y="12.7" width="3" height="3"/><rect fill="currentColor" stroke="none" x="12.7" y="2.3" width="3" height="3"/>',

  // Masks, puppet & rig
  'mask-square': '<path fill="currentColor" stroke="none" fill-rule="evenodd" d="M3.5 2 H14.5 A1.5 1.5 0 0 1 16 3.5 V14.5 A1.5 1.5 0 0 1 14.5 16 H3.5 A1.5 1.5 0 0 1 2 14.5 V3.5 A1.5 1.5 0 0 1 3.5 2 Z M5 6 V12 H13 V6 Z"/>',
  'mask-circle': '<path fill="currentColor" stroke="none" fill-rule="evenodd" d="M3.5 2 H14.5 A1.5 1.5 0 0 1 16 3.5 V14.5 A1.5 1.5 0 0 1 14.5 16 H3.5 A1.5 1.5 0 0 1 2 14.5 V3.5 A1.5 1.5 0 0 1 3.5 2 Z M9 5 A4 4 0 1 0 9 13 A4 4 0 1 0 9 5 Z"/>',
  'mask-pen': '<path fill="currentColor" stroke="none" fill-rule="evenodd" d="M3.5 2 H14.5 A1.5 1.5 0 0 1 16 3.5 V14.5 A1.5 1.5 0 0 1 14.5 16 H3.5 A1.5 1.5 0 0 1 2 14.5 V3.5 A1.5 1.5 0 0 1 3.5 2 Z M5 12.6 C5 8.6 7 5.2 12.8 5 C13.2 9.4 10.6 12.6 5 12.6 Z"/>',
  'puppet-starch': '<g transform="translate(-0.9 -1.3) scale(.84) rotate(45 9 9)" stroke-width="1.75"><path d="M6 2.4 H12"/><path d="M7.2 2.4 V7 L5 10.4 H13 L10.8 7 V2.4"/><path d="M9 10.4 V16.4"/></g><path d="M11.2 16.4 L16.4 11.2 M13.9 16.6 L16.6 13.9 M10.9 13.6 L13.6 10.9" stroke-width="1.3"/>',
  'puppet-bend': '<g transform="translate(-0.9 -1.3) scale(.84) rotate(45 9 9)" stroke-width="1.75"><path d="M6 2.4 H12"/><path d="M7.2 2.4 V7 L5 10.4 H13 L10.8 7 V2.4"/><path d="M9 10.4 V16.4"/></g><path d="M11 16 A5 5 0 0 0 16 11"/><path d="M13.7 11.2 L16.1 10.8 L16.6 13.2" stroke-width="1.3"/>',
  'puppet-advanced': '<g transform="translate(-0.9 -1.3) scale(.84) rotate(45 9 9)" stroke-width="1.75"><path d="M6 2.4 H12"/><path d="M7.2 2.4 V7 L5 10.4 H13 L10.8 7 V2.4"/><path d="M9 10.4 V16.4"/></g><circle cx="13.7" cy="13.7" r="2.7" stroke-width="1.3"/><circle cx="13.7" cy="13.7" r=".95" fill="currentColor" stroke="none"/>',
  'puppet-overlap': '<g transform="translate(-0.9 -1.3) scale(.84) rotate(45 9 9)" stroke-width="1.75"><path d="M6 2.4 H12"/><path d="M7.2 2.4 V7 L5 10.4 H13 L10.8 7 V2.4"/><path d="M9 10.4 V16.4"/></g><rect x="10.4" y="10.4" width="4.2" height="4.2" stroke-width="1.3"/><rect fill="currentColor" stroke="none" x="12.6" y="12.6" width="4.4" height="4.4"/>',
  'bone': '<circle cx="4.6" cy="13.4" r="2.2"/><circle cx="13.9" cy="4.1" r="1.5"/><path d="M3.04 11.84 L12.84 3.04 M6.16 14.96 L14.96 5.16"/>',

  // Layer, animate & snapping
  'layer-plus': '<path d="M8 2.8 L14.6 6.1 L8 9.4 L1.4 6.1 Z"/><path d="M1.4 9.6 L8 12.9 L10.2 11.8"/><path d="M14 10.6 V16.2 M11.2 13.4 H16.8"/>',
  // Object Matte: a picture frame with the AI sparkle (the pixel set uses Fluent image_sparkle).
  'object-matte': '<path d="M9 3 H3.5 A1.5 1.5 0 0 0 2 4.5 V14.5 A1.5 1.5 0 0 0 3.5 16 H13.5 A1.5 1.5 0 0 0 15 14.5 V10"/><path d="M2.4 13.6 L6.6 9.6 L10 12.8 L11.6 11.4 L14.8 14.2"/><path fill="currentColor" stroke="none" d="M14 1 L14.9 3.6 L17.5 4.5 L14.9 5.4 L14 8 L13.1 5.4 L10.5 4.5 L13.1 3.6 Z"/>',
  'magic-wand': '<path d="M2.8 15.2 L9.6 8.4" stroke-width="2.2"/><path fill="currentColor" stroke="none" d="M12.6 1.6 L13.6 4.4 L16.4 5.4 L13.6 6.4 L12.6 9.2 L11.6 6.4 L8.8 5.4 L11.6 4.4 Z"/><path d="M14.8 11.2 V14 M13.4 12.6 H16.2 M5.6 3 V5.4 M4.4 4.2 H6.8" stroke-width="1.2"/>',
  'undo': '<path d="M6.4 3.4 L2.9 6.9 L6.4 10.4"/><path d="M2.9 6.9 H11 A4 4 0 0 1 11 14.9 H7.4"/>',
  'redo': '<path d="M11.6 3.4 L15.1 6.9 L11.6 10.4"/><path d="M15.1 6.9 H7 A4 4 0 0 0 7 14.9 H10.6"/>',
  'more-horizontal': '<circle fill="currentColor" stroke="none" cx="3.8" cy="9" r="1.35"/><circle fill="currentColor" stroke="none" cx="9" cy="9" r="1.35"/><circle fill="currentColor" stroke="none" cx="14.2" cy="9" r="1.35"/>',
  'arrow-left': '<path d="M15 9 H3.4 M8 4.4 L3.4 9 L8 13.6"/>',

  // 3D scene controls
  'pan-camera': '<path d="M9 2 V16 M2 9 H16"/><path d="M6.9 4.1 L9 2 L11.1 4.1 M6.9 13.9 L9 16 L11.1 13.9 M4.1 6.9 L2 9 L4.1 11.1 M13.9 6.9 L16 9 L13.9 11.1"/>',
  'perspective': '<path d="M9 2.6 V15.4"/><path d="M7.3 4.3 L9 2.6 L10.7 4.3" stroke-width="1.3"/><path d="M5.2 11.6 L9 15.4 L12.8 11.6"/><path d="M2.4 8 H5.6 M12.4 8 H15.6" stroke-width="1.3"/>',
  'gizmo-universal': '<path d="M6.5 11.5 V5 M6.5 11.5 H12.6 M6.5 11.5 L3.8 14.2"/><path fill="currentColor" stroke="none" d="M6.5 1.6 L8.6 5.2 H4.4 Z"/><rect fill="currentColor" stroke="none" x="12.6" y="9.8" width="3.4" height="3.4"/><circle fill="currentColor" stroke="none" cx="3" cy="15" r="1.8"/>',
  'gizmo-position': '<path d="M6.5 11.5 V5 M6.5 11.5 H13 M6.5 11.5 L4 14"/><path fill="currentColor" stroke="none" d="M6.5 1.6 L8.6 5.2 H4.4 Z"/><path fill="currentColor" stroke="none" d="M16.4 11.5 L12.8 13.6 V9.4 Z"/><path fill="currentColor" stroke="none" d="M1.6 16.4 L2.4 12.6 L5.4 15.6 Z"/>',
  'gizmo-scale': '<path d="M6.5 11.5 V5 M6.5 11.5 H13 M6.5 11.5 L4 14"/><rect fill="currentColor" stroke="none" x="4.8" y="1.8" width="3.4" height="3.4"/><rect fill="currentColor" stroke="none" x="12.8" y="9.8" width="3.4" height="3.4"/><rect fill="currentColor" stroke="none" x="1.6" y="13" width="3.4" height="3.4"/>',
  'gizmo-rotation': '<path d="M15 9 A6 6 0 1 1 12 3.8"/><path fill="currentColor" stroke="none" d="M10.9 1.6 L14.9 4.6 L10.6 6.2 Z"/><circle fill="currentColor" stroke="none" cx="9" cy="9" r="1.6"/>',
  'axis-local': '<rect x="2.25" y="2.25" width="13.5" height="13.5" rx="1" stroke-width="1.3"/><path d="M8 5.6 V10 H12.6 M8 10 L5.6 12.4"/>',
  'axis-world': '<circle cx="9" cy="9" r="6.9" stroke-width="1.3"/><path d="M8 5.6 V10 H12.6 M8 10 L5.6 12.4"/>',
  'axis-view': '<path d="M5.4 2.4 H12.6 L16 15.6 H2 Z" stroke-width="1.3"/><path d="M8 5.6 V10 H12.6 M8 10 L5.6 12.4"/>',
  'cube': '<path d="M9 1.9 L15.2 5.4 V12.6 L9 16.1 L2.8 12.6 V5.4 Z"/><path d="M2.8 5.4 L9 9 L15.2 5.4 M9 9 V16.1"/>',

  // ── The After Effects-style chrome set (PIXEL_ICON_NAMES below). Icon.tsx
  // draws these names from pixelIcons.generated.ts — Fluent System Icons' own
  // 16- and 20-grid drawings (owner, 2026-10-26: a real pixel-grid family, not
  // hand-drawn glyphs). The markup here is the pre-Fluent 16-grid sketch, kept
  // only so the name stays in the drawn vocabulary; it is never drawn.
  'mouse-pointer': '<path d="M4.5 2.5v10l2.6-2.4L9 13.5l1.6-.8-1.9-3.3h3.4Z"/>',
  'hand': '<path d="M5.5 8.5v-5a1 1 0 0 1 2 0v4m0-5a1 1 0 0 1 2 0v5m0-4a1 1 0 0 1 2 0v5m-6 0-1.3-1.5a1.1 1.1 0 0 0-1.7 1.4L5 12.6c.5 .8 1.3 1 2.3 1h2.2c1.6 0 2.5-1 2.5-2.6V8"/>',
  'zoom-in': '<circle cx="6.5" cy="6.5" r="4"/><path d="M9.5 9.5 14 14M4.5 6.5h4M6.5 4.5v4"/>',
  'zoom-out': '<circle cx="6.5" cy="6.5" r="4"/><path d="M9.5 9.5 14 14M4.5 6.5h4"/>',
  'orbit': '<circle cx="8" cy="8" r="3.5"/><path d="M2.5 8c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5" stroke-dasharray="1 1.5"/><path d="M11.5 3.5 13.5 2.5l-.3 2.2"/>',
  'rotate': '<path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2"/><path d="M12.5 2.5v3h-3"/>',
  'pan-behind': '<path d="M8 1.5v13M1.5 8h13"/><circle cx="8" cy="8" r="2.5"/><path d="M4 4 6 6M12 4l-2 2M4 12l2-2M12 12l-2-2"/>',
  'square': '<rect x="2.5" y="3.5" width="11" height="9"/>',
  'circle': '<ellipse cx="8" cy="8" rx="5.5" ry="4.5"/>',
  'star': '<path d="M8 1.8l1.9 3.9 4.3 .6-3.1 3 .7 4.2L8 11.5l-3.8 2 .7-4.2-3.1-3 4.3-.6Z"/>',
  'pen': '<path d="M9.5 2.5 13.5 6.5 6 14H2v-4Z"/><path d="M8 4l4 4"/>',
  'type': '<path d="M3.5 3.5h9M8 3.5v10M6 13.5h4"/>',
  'brush': '<path d="M13.5 2.5 7 9m-2 .5c-1.5 0-2.5 1-2.5 2.5 0 1-.5 1.5-1 1.5 2.5 .5 5.5-.5 5.5-2.5 0-.8-.7-1.5-2-1.5Z"/>',
  'eraser': '<path d="M9.5 2.5l4 4-7 7h-4l-1-1 8-10Z"/><path d="M6 6l4 4M3 13.5h10.5"/>',
  'puppet-pin': '<path d="M8 2.5v4M8 13.5v-3"/><circle cx="8" cy="8.5" r="2"/><path d="M4.5 4.5 6.3 6.3M11.5 4.5 9.7 6.3"/>',
  'magnet': '<path d="M4.5 2.5v6a3.5 3.5 0 0 0 7 0v-6M4.5 5.5h2.5M9 5.5h2.5"/><path d="M4.5 2.5h2.5v3H4.5ZM9 2.5h2.5v3H9Z"/>',
  'search': '<circle cx="6.5" cy="6.5" r="4"/><path d="M9.5 9.5 14 14"/>',
  'composition': '<rect x="1.5" y="3.5" width="13" height="9"/><path d="M4 3.5v9M12 3.5v9M1.5 6h2.5M1.5 10h2.5M12 6h2.5M12 10h2.5"/>',
  'video': '<rect x="1.5" y="2.5" width="13" height="11"/><path d="M1.5 5.5h13M1.5 10.5h13M4.5 2.5v3M8 2.5v3M11.5 2.5v3M4.5 10.5v3M8 10.5v3M11.5 10.5v3"/>',
  'solid': '<rect x="2.5" y="2.5" width="11" height="11"/><path d="M2.5 13.5 13.5 2.5"/>',
  'audio': '<path d="M2.5 6.5h2.5l3.5-3v9l-3.5-3H2.5Z"/><path d="M10.5 5.5c1.3 1.3 1.3 3.7 0 5M12.5 3.5c2.5 2.5 2.5 6.5 0 9"/>',
  'audio-off': '<path d="M2.5 6.5h2.5l3.5-3v9l-3.5-3H2.5Z"/><path d="M10.5 6l3 4M13.5 6l-3 4"/>',
  'shape': '<path d="M8 1.8l6 3.6-2.3 7.1H4.3L2 5.4Z"/>',
  'adjustment': '<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11a5.5 5.5 0 0 0 0-11Z" fill="currentColor" stroke="none"/>',
  'camera': '<rect x="1.5" y="4.5" width="9" height="7"/><path d="M10.5 7.5 14.5 5.5v5l-4-2"/>',
  'light': '<path d="M5.5 11.5a4 4 0 1 1 5 0v1.5h-5Z"/><path d="M6.5 14.5h3"/>',
  'folder-plus': '<path d="M1.5 3.5h5l1.5 1.5h6.5v8h-13Z"/><path d="M8 7v4M6 9h4"/>',
  'trash': '<path d="M2.5 4.5h11M6 4.5v-2h4v2M4 4.5l1 9h6l1-9M6.5 7v4.5M9.5 7v4.5"/>',
  'menu': '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/>',
  'close': '<path d="M4 4l8 8M12 4l-8 8"/>',
  'chevron-down': '<path d="M5 6.5 8 9.5l3-3"/>',
  'chevron-up': '<path d="M5 9.5 8 6.5l3 3"/>',
  'chevron-left': '<path d="M9.5 5 6.5 8l3 3"/>',
  'chevron-right': '<path d="M6.5 5 9.5 8l-3 3"/>',
  'grid': '<rect x="2.5" y="2.5" width="11" height="11"/><path d="M6.5 2.5v11M9.5 2.5v11M2.5 6.5h11M2.5 9.5h11"/>',
  'eye': '<path d="M1.5 8c1.5-3 3.8-4.5 6.5-4.5S13 5 14.5 8c-1.5 3-3.8 4.5-6.5 4.5S3 11 1.5 8Z"/><circle cx="8" cy="8" r="2"/>',
  'eye-off': '<path d="M1.5 8c1.5-3 3.8-4.5 6.5-4.5S13 5 14.5 8c-1.5 3-3.8 4.5-6.5 4.5S3 11 1.5 8Z"/><path d="M3 13 13 3"/>',
  'lock': '<rect x="4.5" y="7.5" width="7" height="6"/><path d="M6 7.5v-2a2 2 0 0 1 4 0v2"/>',
  'unlock': '<rect x="4.5" y="7.5" width="7" height="6"/><path d="M6 7.5v-2a2 2 0 0 1 4 0"/>',
  'stopwatch': '<circle cx="8" cy="9" r="4.5"/><path d="M8 6.5V9h2M6.5 2.5h3M8 2.5v2M12 5l1-1"/>',
  'keyframe': '<path d="M8 2.5 13.5 8 8 13.5 2.5 8Z"/>',
  'skip-back': '<g fill="currentColor" stroke="none"><path d="M3 3h2v10H3ZM13 3v10L6 8Z"/></g>',
  'skip-forward': '<g fill="currentColor" stroke="none"><path d="M11 3h2v10h-2ZM3 3v10l7-5Z"/></g>',
  'loop': '<path d="M3.5 7.5v-1a2 2 0 0 1 2-2h7"/><path d="M10.5 2.5l2 2-2 2"/><path d="M12.5 8.5v1a2 2 0 0 1-2 2h-7"/><path d="M5.5 13.5l-2-2 2-2"/>',
  'motion-blur': '<circle cx="9.5" cy="8" r="3.5"/><path d="M2.5 6h3M1.5 8h4M2.5 10h3" opacity=".7"/>',
  'shy': '<path d="M3.5 7c1-1 2.5-1.5 4.5-1.5S11.5 6 12.5 7"/><path d="M5 9.5c.8 1 1.8 1.5 3 1.5s2.2-.5 3-1.5"/><circle cx="8" cy="9" r=".8" fill="currentColor"/>',
  '3d': '<path d="M3.5 5.5 8 3l4.5 2.5v5L8 13l-4.5-2.5Z"/><path d="M3.5 5.5 8 8l4.5-2.5M8 8v5"/>',
  'draft-3d': '<path d="M3.5 5.5 8 3l4.5 2.5v5L8 13l-4.5-2.5Z" stroke-dasharray="1.5 1.2"/><path d="M3.5 5.5 8 8l4.5-2.5M8 8v5" stroke-dasharray="1.5 1.2"/>',
  'graph-value': '<path d="M2.5 12.5c3-1 3-8 6-8s2.5 6 5 6"/><rect x="7.5" y="3.5" width="2" height="2" fill="currentColor" stroke="none"/><rect x="12.5" y="9.5" width="2" height="2" fill="currentColor" stroke="none"/>',
  'graph-speed': '<path d="M2.5 12.5h3l2-8 2 8h4"/><rect x="6.5" y="3.5" width="2" height="2" fill="currentColor" stroke="none"/>',
  'marker': '<path d="M4.5 2.5h7v7L8 13.5 4.5 9.5Z"/>',
  'align-left': '<path d="M2.5 2v12"/><rect x="4.5" y="4.5" width="8" height="2.5"/><rect x="4.5" y="9" width="5" height="2.5"/>',
  'align-center': '<path d="M8 2v12"/><rect x="3.5" y="4.5" width="9" height="2.5"/><rect x="5.5" y="9" width="5" height="2.5"/>',
  'align-right': '<path d="M13.5 2v12"/><rect x="3.5" y="4.5" width="8" height="2.5"/><rect x="6.5" y="9" width="5" height="2.5"/>',
  'align-top': '<path d="M2 2.5h12"/><rect x="4.5" y="4.5" width="2.5" height="8"/><rect x="9" y="4.5" width="2.5" height="5"/>',
  'align-middle': '<path d="M2 8h12"/><rect x="4.5" y="3.5" width="2.5" height="9"/><rect x="9" y="5.5" width="2.5" height="5"/>',
  'align-bottom': '<path d="M2 13.5h12"/><rect x="4.5" y="3.5" width="2.5" height="8"/><rect x="9" y="6.5" width="2.5" height="5"/>',
  'distribute-horizontal': '<path d="M2.5 2v12M13.5 2v12"/><rect x="6.5" y="5" width="3" height="6"/>',
  'distribute-vertical': '<path d="M2 2.5h12M2 13.5h12"/><rect x="5" y="6.5" width="6" height="3"/>',
} as const satisfies Partial<Record<IconName, string>>;

/** Names that draw the same object as another name (kept: call sites spell them). */
const ALIASES = {
  diamond: 'keyframe',
  'select-arrow': 'mouse-pointer',
  'rotate-cw': 'rotate',
  box: 'cube',
} as const satisfies Partial<Record<IconName, keyof typeof GLYPHS>>;

/** The names drawn on the 16-unit pixel grid (Icon.tsx renders them pixel-exact). */
export const PIXEL_ICON_NAMES: ReadonlySet<IconName> = new Set<IconName>([
  'mouse-pointer',
  'hand',
  'zoom-in',
  'zoom-out',
  'orbit',
  'rotate',
  'pan-behind',
  'square',
  'circle',
  'star',
  'pen',
  'type',
  'brush',
  'eraser',
  'puppet-pin',
  'magnet',
  'search',
  'composition',
  'video',
  'solid',
  'audio',
  'audio-off',
  'shape',
  'adjustment',
  'camera',
  'light',
  'folder-plus',
  'trash',
  'menu',
  'close',
  'chevron-down',
  'chevron-up',
  'chevron-left',
  'chevron-right',
  'grid',
  'eye',
  'eye-off',
  'lock',
  'unlock',
  'stopwatch',
  'keyframe',
  'skip-back',
  'skip-forward',
  'loop',
  'motion-blur',
  'shy',
  '3d',
  'draft-3d',
  'graph-value',
  'graph-speed',
  'marker',
  'align-left',
  'align-center',
  'align-right',
  'align-top',
  'align-middle',
  'align-bottom',
  'distribute-horizontal',
  'distribute-vertical',
  'diamond',
  'mask-square',
  'mask-circle',
  'mask-pen',
  'mask-feather',
  'undo',
  'redo',
  'gizmo-universal',
  'gizmo-position',
  'gizmo-scale',
  'gizmo-rotation',
  'axis-local',
  'axis-world',
  'axis-view',
  'cube',
  'layer-plus',
  'magic-wand',
  'object-matte',
  'more-horizontal',
  'pan-camera',
  'perspective',
  'ground-grid',
]);
export const PIXEL_ICON_VIEWBOX = '0 0 16 16';

export const DRAWN_ICONS: Partial<Record<IconName, string>> = {
  ...GLYPHS,
  ...Object.fromEntries(Object.entries(ALIASES).map(([alias, target]) => [alias, GLYPHS[target]])),
};
