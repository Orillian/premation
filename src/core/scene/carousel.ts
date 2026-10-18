/**
 * Create Carousel — the selected layers arranged as a moving 3D carousel, as
 * ONE history entry (an engine gesture). Four layouts:
 *
 *   ring         cards on a horizontal ring around a centre, facing outward,
 *                turning (a lazy-Susan / product carousel)
 *   vertical     the same ring stood up on edge (a Ferris wheel / slot reel)
 *   coverflow    cards in a row; the front one faces the camera, the ones
 *                either side turn in and step back (Cover Flow)
 *   stack        cards in a deck receding in depth; the front card slides
 *                away and the next comes forward (a card stack / story deck)
 *
 * A "Carousel" null is the centre (3D) and carries four sliders:
 *
 *   Size         ring radius, or the spacing between cards
 *   Speed        degrees per second; 360° is one full cycle through the cards
 *   Spin         degrees added on top — keyframe it for an eased stop, a
 *                step-through, a scrub
 *   Angle        ring: lean toward the camera · cover flow: how far the side
 *                cards turn · stack: fan (each card's tilt) · vertical: unused
 *
 * Each card is 3D, its Position / rotations (/ opacity for the stack) driven
 * by expression from the null and the sliders. Expressions rather than
 * keyframes, so the size or speed is one slider, not a re-bake — and the
 * carousel stays a plain layer setup a user can take apart.
 *
 * The cards are read in comp space, so they are unparented first.
 */

import type { Command as EngineCommand, Value } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { documentMirror } from '@stores/documentMirror';

export type CarouselMode = 'ring' | 'vertical' | 'coverflow' | 'stack';

export const CAROUSEL_MODES: ReadonlyArray<{ mode: CarouselMode; label: string; description: string }> = [
  { mode: 'ring', label: 'Ring', description: 'Cards on a turning horizontal ring, facing outward' },
  { mode: 'vertical', label: 'Ferris Wheel', description: 'Cards on a ring stood on edge, rolling over the top' },
  { mode: 'coverflow', label: 'Cover Flow', description: 'A row of cards; the front faces you, the sides turn in and step back' },
  { mode: 'stack', label: 'Card Stack', description: 'A deck in depth; the front card slides away and the next comes forward' },
];

export const CAROUSEL_CONTROL_NAMES = {
  size: 'Carousel Size',
  speed: 'Carousel Speed',
  spin: 'Carousel Spin',
  angle: 'Carousel Angle',
} as const;

export type CarouselControlNames = { -readonly [K in keyof typeof CAROUSEL_CONTROL_NAMES]: string };

/** Per card, the expression for each property it drives. */
export type CarouselExpressions = Array<[path: string, source: string]>;

const q = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** How far the carousel has turned, in degrees (Spin + time × Speed). */
const turn = (n: CarouselControlNames): string => `(ctrl(${q(n.spin)}) + time * ctrl(${q(n.speed)}))`;

/** Card `index`'s angle on a ring of `count`, in radians. */
const ringAngle = (index: number, count: number, n: CarouselControlNames): string =>
  `((${turn(n)} + ${index * (360 / count)}) * Math.PI / 180)`;

/**
 * Card `index`'s slot relative to the front, in cards, wrapped into
 * [low, low + count): 0 is the front, 1 the next, negative already passed.
 * One full turn (360°) moves every card through every slot once.
 */
const slot = (index: number, count: number, low: number, n: CarouselControlNames): string => {
  const raw = `(${index} - ${turn(n)} / 360 * ${count} - ${low})`;
  return `(${raw} - ${count} * Math.floor(${raw} / ${count}) + ${low})`;
};

/**
 * The expressions placing card `index` of `count` around `center` in `mode`.
 * Angle conventions follow the engine's: a layer's Y Rotation r turns its
 * face to (-sin r, 0, -cos r), its X Rotation r to (0, sin r, -cos r).
 */
export function carouselExpressions(
  mode: CarouselMode,
  center: string,
  index: number,
  count: number,
  n: CarouselControlNames,
): CarouselExpressions {
  const c = `thisComp.layer(${q(`#${center}`)}).position`;
  const size = `ctrl(${q(n.size)})`;
  const angle = `ctrl(${q(n.angle)})`;
  switch (mode) {
    case 'ring': {
      const a = ringAngle(index, count, n);
      const t = `(${angle} * Math.PI / 180)`;
      return [
        ['transform/position', `add(${c}, [Math.sin(${a}) * ${size}, Math.cos(${a}) * ${size} * Math.sin(${t}), -Math.cos(${a}) * ${size} * Math.cos(${t})])`],
        ['transform/yRotation', `-(${a}) * 180 / Math.PI`],
        ['transform/xRotation', `-${angle}`],
      ];
    }
    case 'vertical': {
      const a = ringAngle(index, count, n);
      return [
        ['transform/position', `add(${c}, [0, -Math.sin(${a}) * ${size}, -Math.cos(${a}) * ${size}])`],
        ['transform/xRotation', `-(${a}) * 180 / Math.PI`],
      ];
    }
    case 'coverflow': {
      // Centred on the front card: slots run -count/2 … count/2.
      const k = slot(index, count, -count / 2, n);
      const side = `Math.max(-1, Math.min(1, ${k}))`;
      return [
        ['transform/position', `add(${c}, [${k} * ${size} * 0.55 + ${side} * ${size} * 0.45, 0, Math.abs(${side}) * ${size} * 0.8])`],
        ['transform/yRotation', `${side} * ${angle}`],
        // Invisible at the seam, where a card wraps from one end to the other.
        ['transform/opacity', `100 * Math.max(0, Math.min(1, (${count / 2} - Math.abs(${k})) * 2))`],
      ];
    }
    case 'stack': {
      // Slot -1…0 is the card leaving the front; 0 is the front of the deck.
      const k = slot(index, count, -1, n);
      const leaving = `Math.max(0, -${k})`;
      return [
        ['transform/position', `add(${c}, [-${leaving} * ${size} * 3, Math.max(0, ${k}) * -${size} * 0.12, Math.max(0, ${k}) * ${size}])`],
        ['transform/rotation', `Math.max(0, ${k}) * ${angle} - ${leaving} * 12`],
        // Fades out as it leaves, fades in at the back, dims with depth.
        ['transform/opacity', `100 * Math.min(1, ${count - 1} - ${k}) * (1 - ${leaving}) * (1 - Math.max(0, ${k}) * ${(0.5 / Math.max(1, count - 1)).toFixed(4)})`],
      ];
    }
  }
}

const scalar = (value: number): Value => ({ kind: 'scalar', value });

export interface Carousel {
  controls: string;
  cards: string[];
  names: CarouselControlNames;
}

/**
 * Build a `mode` carousel from `cards` (in order) as one undo entry.
 * Resolves to what was made, or null when the engine refused a step (the
 * gesture is rolled back) or there is nothing to arrange.
 */
export async function createCarouselEdit(cards: readonly string[], mode: CarouselMode = 'ring'): Promise<Carousel | null> {
  const m = documentMirror();
  const layers = cards.map((id) => m.layer(id)).filter((l): l is NonNullable<typeof l> => !!l && l.kind !== 'camera' && l.kind !== 'light');
  if (layers.length < 2) return null;
  const comp = layers[0]!.comp;
  if (!comp || layers.some((l) => l.comp !== comp)) return null;
  const settings = m.comp(comp)?.settings;
  if (!settings) return null;

  const e = engine();
  const began = await e.execute({ type: 'beginGesture', label: 'Create Carousel' });
  if (!began.ok) return null;
  let ok = false;
  let made: Carousel | null = null;
  const run = async <T>(cmd: EngineCommand): Promise<T | null> => {
    const r = await e.execute(cmd);
    return r.ok ? (r.value as T) : null;
  };
  try {
    // Slider names are global to the expression host, so a second carousel
    // numbers itself and its sliders rather than steering the first.
    const nth = carouselsIn(comp) + 1;
    const suffix = nth === 1 ? '' : ` ${nth}`;
    const names = Object.fromEntries(
      Object.entries(CAROUSEL_CONTROL_NAMES).map(([k, v]) => [k, `${v}${suffix}`]),
    ) as CarouselControlNames;

    const ctl = await run<{ layer: string }>({ type: 'createLayer', comp, kind: 'null', name: `Carousel${suffix}`, init: [] });
    if (!ctl) return null;
    if (!(await run({ type: 'setLayerSwitches', layers: [ctl.layer], patch: { threeD: true } }))) return null;

    const duration = Math.max(1, settings.duration);
    const defaults: Record<keyof CarouselControlNames, number> = {
      size: Math.round(settings.width * (mode === 'stack' ? 0.12 : mode === 'coverflow' ? 0.22 : 0.3)),
      speed: Math.round((360 / duration) * 100) / 100,
      spin: 0,
      angle: mode === 'coverflow' ? 55 : mode === 'stack' ? 3 : mode === 'ring' ? 8 : 0,
    };
    for (const key of Object.keys(defaults) as Array<keyof CarouselControlNames>) {
      const added = await run<{ groups: string[] }>({
        type: 'addPropertyGroup', layer: ctl.layer, parent: 'effects', matchName: 'ADBE Slider Control', name: names[key],
        init: [{ path: 'slider', value: scalar(defaults[key]) }],
      });
      if (!added) return null;
    }

    const ids = layers.map((l) => l.id);
    if (!(await run({ type: 'setLayerSwitches', layers: ids, patch: { threeD: true } }))) return null;
    for (const [i, l] of layers.entries()) {
      if (l.parent && !(await run({ type: 'setParent', layers: [l.id], keepWorldTransform: true }))) return null;
      for (const [path, source] of carouselExpressions(mode, ctl.layer, i, layers.length, names)) {
        if (!(await run({ type: 'setExpression', prop: { layer: l.id, path }, source, enabled: true }))) return null;
      }
    }

    made = { controls: ctl.layer, cards: ids, names };
    ok = true;
  } finally {
    await e.execute({ type: 'endGesture', gesture: began.value.gesture, commit: ok });
  }
  return ok ? made : null;
}

/** Carousel nulls already in `comp` (named "Carousel" or "Carousel N"). */
function carouselsIn(comp: string): number {
  const m = documentMirror();
  return (m.comp(comp)?.layers ?? []).filter((id) => /^Carousel( \d+)?$/.test(m.layer(id)?.name ?? '')).length;
}
