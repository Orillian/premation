/**
 * The Object Matte tool's prompts in the Roto Brush store: a click is a
 * one-point stroke on its frame; a plain click starts that frame over, Shift
 * adds, Alt subtracts; a box is layer-local and converts to the job's Rect.
 */

import { lassoPrompts, useRotoBrushStore } from './rotoBrushStore';
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

it('a lasso becomes points inside it and points just outside its edge, replacing this frame', () => {
  const s = useRotoBrushStore.getState();
  s.addPoint({ x: 9, y: 9 }, 0, 'new');
  const square = [{ x: -50, y: -50 }, { x: 50, y: -50 }, { x: 50, y: 50 }, { x: -50, y: 50 }];
  expect(s.setLasso(square, 0)).toBe(true);
  const strokes = useRotoBrushStore.getState().strokes;
  expect(strokes.map((x) => x.kind)).toEqual(['fg', 'bg']);
  for (const p of strokes[0]!.points) expect(Math.abs(p.x) < 50 && Math.abs(p.y) < 50).toBe(true);
  for (const p of strokes[1]!.points) expect(Math.max(Math.abs(p.x), Math.abs(p.y))).toBeGreaterThan(50);
});

it('refuses a lasso with no inside', () => {
  expect(lassoPrompts([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBeNull();
  expect(lassoPrompts([{ x: 0, y: 0 }, { x: 100, y: 1 }, { x: 200, y: 0 }])).toBeNull();
});
