/**
 * Per-layer blend modes.
 *
 * The blend mode lives on the node's `fx` component (sibling to the effect
 * stack), so History / autosave / export capture it for free.
 *
 * ── How a mode actually reaches pixels ───────────────────────────────
 * There is ONE rendering engine and it is GPU-backed (WebGPU -> WebGL2, see
 * createRenderBackend.ts). Every mode except Normal composites through the
 * BLEND_COMBINE shader, which samples the backdrop and implements the W3C
 * compositing formula in both WGSL and GLSL. `snapshotToFrameScene.advancedBlendId`
 * maps each mode here onto that shader's integer selector.
 *
 * This file used to say the app composited on Canvas 2D, and that the mode list
 * was therefore capped at what `globalCompositeOperation` renders natively. That
 * stopped being true when the engine was unified; the claim survived and was the
 * reason the remaining AE modes were estimated as far more expensive than they
 * are. `blendToComposite()` — which returned a GlobalCompositeOperation and was
 * called by nothing but its own test — is deleted along with the claim. So is
 * the `gpuSafe` flag, which described a Canvas2D-to-GPU fallback that no longer
 * exists.
 *
 * ── Coverage ─────────────────────────────────────────────────────────
 * All 38 of AE's 38. Dissolve and Dancing Dissolve (M5) landed last: the cost
 * was never the blend but a determinism contract between preview and export,
 * met the same way Roughen met it — an integer hash of (comp-grid pixel, seed),
 * no Math.random, so a scrub back to the same frame redraws the same speckle
 * and export matches preview at any zoom. Dancing Dissolve's seed is the frame
 * index, threaded scene-wide (`FrameScene.dissolveFrame`); plain Dissolve's is
 * 0, which is what makes its pattern hold still.
 *
 * The four Stencil/Silhouette modes (M8c) are now in. They were estimated as
 * needing "a compositing-group boundary" first; that boundary already existed.
 * The advanced-blend path renders the layer to one target, copies the
 * accumulated backdrop to another, and OVERWRITES the group's out target with a
 * function of the two — which is precisely the topology a stencil needs, and
 * precomps already isolate into their own target so the scope is right too.
 * Checking the renderer rather than the estimate turned an L into an M.
 */

import type { SceneNode } from '@core/types';
import { renderComponentsOf } from '@core/scene/SceneGraph';
import { t } from '@core/i18n';

export type LayerBlendMode =
  | 'normal'
  // ── M5: stochastic. Coverage becomes a per-pixel coin flip — a pixel shows
  // the source at FULL opacity with probability equal to its coverage, or the
  // backdrop untouched. Dissolve holds its pattern still and Dancing re-rolls
  // each frame. (Keep this comment free of semicolons — `featureCounts.cjs`
  // captures the union body up to the first one it sees, comments included,
  // and truncates the count.) ──
  | 'dissolve'
  | 'dancing-dissolve'
  | 'add'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity'
  // ── M1 ──
  | 'classic-color-burn'
  | 'linear-burn'
  | 'darker-color'
  | 'classic-color-dodge'
  | 'linear-dodge'
  | 'lighter-color'
  | 'linear-light'
  | 'vivid-light'
  | 'pin-light'
  | 'hard-mix'
  | 'classic-difference'
  | 'subtract'
  | 'divide'
  // ── M4: the Utility family. These write ALPHA, not just colour. ──
  | 'alpha-add'
  | 'luminescent-premul'
  // ── M8c: the Matte family. These replace the backdrop with a SCALED copy of
  // itself and contribute no colour of their own — the layer is a matte, not a
  // participant in the blend. ──
  | 'stencil-alpha'
  | 'stencil-luma'
  | 'silhouette-alpha'
  | 'silhouette-luma';

/**
 * Blend modes in AE's own menu order and AE's own group names, so a user coming
 * from After Effects finds each one where they expect it. The groups are load
 * bearing for the picker's section headers; do not rename them to something
 * tidier.
 *
 * ── The three Classic modes are COMPATIBILITY ALIASES, not distinct maths ──
 * AE keeps `Classic Color Burn` / `Classic Color Dodge` / `Classic Difference`
 * for projects authored before its blend maths was revised. We keep the NAMES so
 * an imported project's mode survives a round trip and the picker matches AE's,
 * but they currently render identically to Color Burn / Color Dodge / Difference.
 *
 * This is stated rather than implied because measurement contradicted the
 * intent: the Classic branches were written as the unclamped forms, and the
 * output-clamp at the end of the channel function collapses them back onto the
 * modern ones — verified, not assumed, by rendering both and comparing. Shipping
 * them as "unclamped variants" would have been a parity claim the pixels do not
 * support. Logged as F9; closing it needs AE's actual pre-7.0 formulas, which we
 * do not have.
 */
export const BLEND_MODES: ReadonlyArray<{ mode: LayerBlendMode; label: string; group: string }> = [
  { mode: 'normal', get label() { return t('core.blendMode.normal', 'Normal'); }, group: 'Normal' },
  { mode: 'dissolve', get label() { return t('core.blendMode.dissolve', 'Dissolve'); }, group: 'Normal' },
  { mode: 'dancing-dissolve', get label() { return t('core.blendMode.dancingDissolve', 'Dancing Dissolve'); }, group: 'Normal' },

  { mode: 'darken', get label() { return t('core.blendMode.darken', 'Darken'); }, group: 'Subtractive' },
  { mode: 'multiply', get label() { return t('core.blendMode.multiply', 'Multiply'); }, group: 'Subtractive' },
  { mode: 'color-burn', get label() { return t('core.blendMode.colorBurn', 'Color Burn'); }, group: 'Subtractive' },
  { mode: 'classic-color-burn', get label() { return t('core.blendMode.classicColorBurn', 'Classic Color Burn'); }, group: 'Subtractive' },
  { mode: 'linear-burn', get label() { return t('core.blendMode.linearBurn', 'Linear Burn'); }, group: 'Subtractive' },
  { mode: 'darker-color', get label() { return t('core.blendMode.darkerColor', 'Darker Color'); }, group: 'Subtractive' },

  { mode: 'add', get label() { return t('core.blendMode.add', 'Add'); }, group: 'Additive' },
  { mode: 'lighten', get label() { return t('core.blendMode.lighten', 'Lighten'); }, group: 'Additive' },
  { mode: 'screen', get label() { return t('core.blendMode.screen', 'Screen'); }, group: 'Additive' },
  { mode: 'color-dodge', get label() { return t('core.blendMode.colorDodge', 'Color Dodge'); }, group: 'Additive' },
  { mode: 'classic-color-dodge', get label() { return t('core.blendMode.classicColorDodge', 'Classic Color Dodge'); }, group: 'Additive' },
  { mode: 'linear-dodge', get label() { return t('core.blendMode.linearDodge', 'Linear Dodge'); }, group: 'Additive' },
  { mode: 'lighter-color', get label() { return t('core.blendMode.lighterColor', 'Lighter Color'); }, group: 'Additive' },

  { mode: 'overlay', get label() { return t('core.blendMode.overlay', 'Overlay'); }, group: 'Complex' },
  { mode: 'soft-light', get label() { return t('core.blendMode.softLight', 'Soft Light'); }, group: 'Complex' },
  { mode: 'hard-light', get label() { return t('core.blendMode.hardLight', 'Hard Light'); }, group: 'Complex' },
  { mode: 'linear-light', get label() { return t('core.blendMode.linearLight', 'Linear Light'); }, group: 'Complex' },
  { mode: 'vivid-light', get label() { return t('core.blendMode.vividLight', 'Vivid Light'); }, group: 'Complex' },
  { mode: 'pin-light', get label() { return t('core.blendMode.pinLight', 'Pin Light'); }, group: 'Complex' },
  { mode: 'hard-mix', get label() { return t('core.blendMode.hardMix', 'Hard Mix'); }, group: 'Complex' },

  { mode: 'difference', get label() { return t('core.blendMode.difference', 'Difference'); }, group: 'Difference' },
  { mode: 'classic-difference', get label() { return t('core.blendMode.classicDifference', 'Classic Difference'); }, group: 'Difference' },
  { mode: 'exclusion', get label() { return t('core.blendMode.exclusion', 'Exclusion'); }, group: 'Difference' },
  { mode: 'subtract', get label() { return t('core.blendMode.subtract', 'Subtract'); }, group: 'Difference' },
  { mode: 'divide', get label() { return t('core.blendMode.divide', 'Divide'); }, group: 'Difference' },

  { mode: 'hue', get label() { return t('core.blendMode.hue', 'Hue'); }, group: 'HSL' },
  { mode: 'saturation', get label() { return t('core.blendMode.saturation', 'Saturation'); }, group: 'HSL' },
  { mode: 'color', get label() { return t('core.blendMode.color', 'Color'); }, group: 'HSL' },
  { mode: 'luminosity', get label() { return t('core.blendMode.luminosity', 'Luminosity'); }, group: 'HSL' },

  { mode: 'alpha-add', get label() { return t('core.blendMode.alphaAdd', 'Alpha Add'); }, group: 'Utility' },
  { mode: 'luminescent-premul', get label() { return t('core.blendMode.luminescentPremul', 'Luminescent Premul'); }, group: 'Utility' },

  { mode: 'stencil-alpha', get label() { return t('core.blendMode.stencilAlpha', 'Stencil Alpha'); }, group: 'Matte' },
  { mode: 'stencil-luma', get label() { return t('core.blendMode.stencilLuma', 'Stencil Luma'); }, group: 'Matte' },
  { mode: 'silhouette-alpha', get label() { return t('core.blendMode.silhouetteAlpha', 'Silhouette Alpha'); }, group: 'Matte' },
  { mode: 'silhouette-luma', get label() { return t('core.blendMode.silhouetteLuma', 'Silhouette Luma'); }, group: 'Matte' },
];

/**
 * The Matte family, which behaves unlike every other mode: the layer draws no
 * colour at all and instead scales the alpha of the whole backdrop beneath it.
 * Callers that reason about "does this layer contribute pixels" need to tell
 * them apart from the rest.
 */
export const MATTE_BLEND_MODES: ReadonlySet<LayerBlendMode> = new Set<LayerBlendMode>([
  'stencil-alpha', 'stencil-luma', 'silhouette-alpha', 'silhouette-luma',
]);

export function isMatteBlend(mode: LayerBlendMode | undefined): boolean {
  return !!mode && MATTE_BLEND_MODES.has(mode);
}

const VALID = new Set<string>(BLEND_MODES.map((b) => b.mode));

export function isBlendMode(v: unknown): v is LayerBlendMode {
  return typeof v === 'string' && VALID.has(v);
}

/** Read a node's blend mode from its `fx` component (defaults to 'normal'). */
export function readNodeBlend(node: SceneNode): LayerBlendMode {
  const fx = renderComponentsOf(node).find((c) => c.type === 'fx');
  const m = fx?.props.blendMode;
  return isBlendMode(m) ? m : 'normal';
}
