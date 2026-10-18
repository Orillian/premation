/**
 * The Brush commits a closed variable-width RIBBON, so it has to land as a
 * filled, closed shape. It used to be listed with the open strokes and came
 * out as a transparent fill with a thin pencil outline round the ribbon — ink
 * with a hollow body. The Pencil, a true open stroke, stays stroked.
 */

import { drawToolOptions } from '@motion/workspace';
import { makeNodeAt } from './ports';

const ribbon = [
  { x: -10, y: -2, inX: -10, inY: -2, outX: -10, outY: -2 },
  { x: 10, y: -2, inX: 10, inY: -2, outX: 10, outY: -2 },
  { x: 10, y: 2, inX: 10, inY: 2, outX: 10, outY: 2 },
  { x: -10, y: 2, inX: -10, inY: 2, outX: -10, outY: 2 },
];

const comp = (node: ReturnType<typeof makeNodeAt>, type: string) =>
  node.components.find((c) => c.type === type)?.props as Record<string, unknown> | undefined;

it('a Brush stroke is filled with the brush colour and closed', () => {
  drawToolOptions.brushColor = '#ff3366';
  const node = makeNodeAt('shape', 'Brush', 0, 0, false, ribbon, 20, 4);
  expect(comp(node, 'Style')?.fill).toBe('#ff3366');
  expect(comp(node, 'Geometry')?.open).toBeUndefined();
});

it('a Pencil stroke stays an open, stroked line', () => {
  const node = makeNodeAt('shape', 'Pencil', 0, 0, false, ribbon, 20, 4);
  expect(comp(node, 'Style')?.fill).toBe('rgba(0,0,0,0)');
  expect(comp(node, 'Geometry')?.open).toBe(true);
});
