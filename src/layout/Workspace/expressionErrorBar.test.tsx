/**
 * The expression error bar over the viewport, fed the engine's `layerErrors`
 * in the shape the frame build records (stage 'expression', "Line N: …", the
 * property's API path — pinned on the engine side by test_unported_warnings).
 * The headless test engine builds no frames, so the errors are supplied here.
 */

import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import type { LayerError } from '@motion/engine-api';

const ERRORS: LayerError[] = [
  { layer: 'L1', stage: 'expression', message: 'Line 2: Unknown layer "Nope"', path: 'transform/rotation' },
  { layer: 'L2', stage: 'expression', message: 'Line 1: Unknown name "foo"', path: 'transform/opacity' },
  { layer: 'L2', stage: 'unported', message: 'parametric polystar' },
];

const mirror = {
  layer: (id: string) => ({ L1: { name: 'Hero' }, L2: { name: 'Title' } } as Record<string, { name: string }>)[id],
  tree: (id: string) => ({ nodes: new Map([[id === 'L1' ? 'transform/rotation' : 'transform/opacity', { name: id === 'L1' ? 'Rotation' : 'Opacity' }]]) }),
  layerErrors: () => ERRORS,
};

jest.mock('@hooks/useMirror', () => ({
  useActiveCompId: () => 'comp_root',
  useMirrorKeys: () => 0,
  useMirror: () => mirror,
}));
jest.mock('@core/engine/engineInstance', () => ({
  engine: () => ({ query: async () => ({ ok: true, value: { errors: ERRORS } }) }),
}));
const opened: Array<[string, string]> = [];
jest.mock('@layout/Timeline/timelineExpressionEditor', () => ({
  openTimelineExpressionEditor: (layer: string, prop: string) => opened.push([layer, prop]),
}));

// After the mocks it depends on (jest hoists jest.mock above imports anyway).
import { ExpressionErrorBar } from './ExpressionErrorBar';

afterEach(cleanup);

test('lists only expression errors, with the layer, the property and the line', async () => {
  await act(async () => { render(<ExpressionErrorBar />); });
  const bar = await screen.findByRole('alert');
  expect(bar).toHaveTextContent('Hero · Rotation');
  expect(bar).toHaveTextContent('Line 2: Unknown layer "Nope"');
  expect(bar).toHaveTextContent('1 of 2');
  expect(bar).not.toHaveTextContent('polystar');
});

test('◀ ▶ step through the failures and Edit opens the one shown', async () => {
  await act(async () => { render(<ExpressionErrorBar />); });
  fireEvent.click(await screen.findByRole('button', { name: 'Next expression error' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Title · Opacity');
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(opened).toEqual([['L2', 'transform/opacity']]);
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByRole('alert')).toBeNull();
});
