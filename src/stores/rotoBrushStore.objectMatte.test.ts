/**
 * The Object Matte tool's prompts in the Roto Brush store: a click is a
 * one-point stroke on its frame; a plain click starts that frame over, Shift
 * adds, Alt subtracts; a box is layer-local and converts to the job's Rect.
 */

import { useRotoBrushStore } from './rotoBrushStore';
import { boxAt, boxToRect } from '@core/workspace/rotoBrushTool';

beforeEach(() => {
  useRotoBrushStore.getState().setNode(null);
  useRotoBrushStore.getState().setNode('layer');
});

it('a plain click replaces this frame’s prompts and keeps other frames’ corrections', () => {
  const s = useRotoBrushStore.getState();
  s.addPoint({ x: 1, y: 1 }, 0, 'new');
  s.addPoint({ x: 2, y: 2 }, 0, 'add');
  s.addPoint({ x: 3, y: 3 }, 1, 'subtract');
  s.setBox({ x0: 0, y0: 0, x1: 5, y1: 5, time: 0 });
  s.addPoint({ x: 9, y: 9 }, 0, 'new');
  const strokes = useRotoBrushStore.getState().strokes;
  expect(strokes.map((x) => [x.kind, x.time, x.points[0]!.x])).toEqual([
    ['bg', 1, 3],
    ['fg', 0, 9],
  ]);
  expect(useRotoBrushStore.getState().box).toBeNull();
});

it('Shift adds a foreground point, Alt a background one', () => {
  const s = useRotoBrushStore.getState();
  s.addPoint({ x: 1, y: 1 }, 0, 'new');
  s.addPoint({ x: 2, y: 2 }, 0, 'add');
  s.addPoint({ x: 3, y: 3 }, 0, 'subtract');
  expect(useRotoBrushStore.getState().strokes.map((x) => x.kind)).toEqual(['fg', 'fg', 'bg']);
});

it('a box converts to a top-left Rect and belongs to its own frame', () => {
  const box = { x0: 10, y0: -20, x1: -30, y1: 40, time: 2 };
  expect(boxToRect(box, { width: 200, height: 100 })).toEqual({ x: 70, y: 30, width: 40, height: 60 });
  expect(boxAt(box, 2, 30)).toBe(box);
  expect(boxAt(box, 2.1, 30)).toBeNull();
  expect(boxAt(null, 2, 30)).toBeNull();
});

it('a layer change drops the box with the strokes', () => {
  const s = useRotoBrushStore.getState();
  s.setBox({ x0: 0, y0: 0, x1: 1, y1: 1, time: 0 });
  s.setNode('other');
  expect(useRotoBrushStore.getState().box).toBeNull();
});
