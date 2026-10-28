/**
 * The Object Matte effect card (`object-matte`, After Effects' Object Matte):
 * what the propagation reads from it.
 *
 * The engine adds the card to footage the first time it gets an Object Matte
 * (setLayerMatte) and cuts the layer through it. Its Invert / Fine-tune
 * controls (Feather, Contrast, Shift Edge) are live in the shader; the rest
 * are baked into the matte frames by the propagation, so the NEXT propagation
 * reads them here — the card is the one place they are edited. Without a card
 * (the layer's first propagation) the Roto tool's own settings are used.
 */

import { documentMirror } from '@stores/documentMirror';
import { mirrorEffects } from '@core/mirror/effects';
import { effectNumber, effectParam, type Effect } from '@core/inspector/effectCatalog';

export const OBJECT_MATTE_EFFECT = 'object-matte';

/** What the `objectMatte` job bakes (its MatteRefine, percent units as the Roto store keeps them). */
export interface ObjectMatteBake {
  edgeRadius: number;
  decontaminate: number;  // 0…100 %
  motionBlur: boolean;
  choke: number;          // −100…100 %
  reduceChatter: number;  // 0…100 %
  featherPx: number;
}

/** The layer's Object Matte card (the first one), or null. */
export function objectMatteCard(nodeId: string): Effect | null {
  return mirrorEffects(documentMirror().tree(nodeId)).find((e) => e.type === OBJECT_MATTE_EFFECT) ?? null;
}

/**
 * The card's propagation settings as the job's refine. Feather and choke are
 * the card's LIVE controls, so nothing of them is baked (0): the frames carry
 * the plain matte and the shader refines it. Quality Best refines the edge
 * band at twice the Edge Radius; Render Refine Edge off bakes no edge refine.
 */
export function bakeFromCard(card: Effect): ObjectMatteBake {
  const on = (k: string): boolean => effectParam(card, k) === true;
  const radius = Math.max(0, effectNumber(card, 'edgeRadius'));
  return {
    edgeRadius: on('renderRefineEdge') ? Math.min(64, radius * (effectNumber(card, 'quality') === 1 ? 2 : 1)) : 0,
    decontaminate: on('decontaminate') ? Math.max(0, Math.min(100, effectNumber(card, 'decontaminationAmount'))) : 0,
    motionBlur: on('motionBlur'),
    choke: 0,
    reduceChatter: on('reduceChatter') ? Math.max(0, Math.min(100, effectNumber(card, 'chatterAmount'))) : 0,
    featherPx: 0,
  };
}

/** The bake for the next propagation on `nodeId`: the card's when it has one, else `fallback` (the Roto tool's). */
export function objectMatteBake(nodeId: string, fallback: ObjectMatteBake): ObjectMatteBake {
  const card = objectMatteCard(nodeId);
  return card ? bakeFromCard(card) : fallback;
}
