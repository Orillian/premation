/**
 * Selection Brush through the engine: a stroke grows the selection's mask by
 * exactly the brushed area, an Alt stroke cuts it back, one entry each; with no
 * selection yet the first stroke becomes one.
 */

import { engineIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import { mirrorMasksAt } from '@core/mirror/masks';
import { maskPathPolyline } from '@core/effects/mask';
import { ROTO_PATH_NAME } from '@core/workspace/rotoBrushTool';
import { documentMirror } from '@stores/documentMirror';
import { applySelectionBrushEdit, largestRing, strokeOutline } from './selectionBrush';

let h: Harness;
let s: Scene;
beforeEach(async () => { h = await setupAppEngine(); s = await buildScene(h); });
afterEach(async () => { await h.dispose(); });

function bounds(layer: string): { x0: number; x1: number; y0: number; y1: number } {
  const mask = mirrorMasksAt(documentMirror(), layer, 0).find((m) => m.name === ROTO_PATH_NAME)!;
  const flat = maskPathPolyline(mask);
  const xs = flat.filter((_, i) => i % 2 === 0);
  const ys = flat.filter((_, i) => i % 2 === 1);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

it('outlines a stroke as a capsule of the brush radius', () => {
  const ring = largestRing(strokeOutline([{ x: 0, y: 0 }, { x: 100, y: 0 }], 10))!;
  const xs = ring.map(([x]) => x);
  const ys = ring.map(([, y]) => y);
  expect(Math.min(...xs)).toBeCloseTo(-10, 0);
  expect(Math.max(...xs)).toBeCloseTo(110, 0);
  expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(20, 0);
});

it('creates, grows and cuts the selection, one entry per stroke', async () => {
  const entries = (await historyLabels()).length;
  expect(await applySelectionBrushEdit(s.V, [{ x: -50, y: 0 }, { x: 50, y: 0 }], 20, false, 0)).toBe(true);
  await engineIdle();
  await documentMirror().loadTrees([s.V]);
  const first = bounds(s.V);
  expect(first.x0).toBeCloseTo(-70, 0);
  expect(first.x1).toBeCloseTo(70, 0);

  // Grow to the right.
  expect(await applySelectionBrushEdit(s.V, [{ x: 60, y: 0 }, { x: 150, y: 0 }], 20, false, 0)).toBe(true);
  await engineIdle();
  expect(bounds(s.V).x1).toBeCloseTo(170, 0);

  // Cut the left end off.
  expect(await applySelectionBrushEdit(s.V, [{ x: -80, y: -40 }, { x: -80, y: 40 }], 30, true, 0)).toBe(true);
  await engineIdle();
  expect(bounds(s.V).x0).toBeGreaterThan(-60);
  expect((await historyLabels()).length).toBe(entries + 3);
});

it('an Alt stroke with no selection changes nothing', async () => {
  expect(await applySelectionBrushEdit(s.V, [{ x: 0, y: 0 }, { x: 10, y: 0 }], 10, true, 0)).toBe(false);
});
